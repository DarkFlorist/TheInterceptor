import * as assert from 'assert'
import { test } from 'bun:test'

type ContentScriptMockState = {
	readonly backgroundMessageListeners: ((message: unknown) => void)[]
	readonly runtimeMessageListeners: ((message: unknown) => unknown)[]
	readonly disconnectListeners: (() => void)[]
	readonly eventListeners: Map<string, EventListenerOrEventListenerObject[]>
	readonly postedMessages: unknown[]
	readonly connectionNames: string[]
	readonly runtime: { lastError: { message?: string } | undefined }
	readonly getConnectionCount: () => number
	readonly failNextPost: () => void
}

type ContentScriptSource = 'manifest-v2-document-start' | 'standalone-listener'

async function withContentScriptMock(source: ContentScriptSource, run: (state: ContentScriptMockState) => Promise<void>) {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
	const interceptorInjectedDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'interceptorInjected')
	const backgroundMessageListeners: ((message: unknown) => void)[] = []
	const runtimeMessageListeners: ((message: unknown) => unknown)[] = []
	const disconnectListeners: (() => void)[] = []
	const eventListeners = new Map<string, EventListenerOrEventListenerObject[]>()
	const postedMessages: unknown[] = []
	const connectionNames: string[] = []
	const runtime: { lastError: { message?: string } | undefined } = { lastError: undefined }
	let connectionCount = 0
	let shouldFailNextPost = false

	const browserMock = {
		runtime: {
			get lastError() { return runtime.lastError },
			getURL: (path: string) => `browser-extension://test/${ path }`,
			connect: ({ name }: { name: string }) => {
				connectionCount += 1
				connectionNames.push(name)
				return {
					disconnect: () => undefined,
					onDisconnect: { addListener: (listener: () => void) => { disconnectListeners.push(listener) } },
					onMessage: { addListener: (listener: (message: unknown) => void) => { backgroundMessageListeners.push(listener) } },
					postMessage: (message: unknown) => {
						if (shouldFailNextPost) {
							shouldFailNextPost = false
							throw new Error('Attempting to use a disconnected port object')
						}
						postedMessages.push(message)
					},
				}
			},
			onMessage: { addListener: (listener: (message: unknown) => unknown) => { runtimeMessageListeners.push(listener) } },
		},
	}
	const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		eventListeners.set(type, [...eventListeners.get(type) ?? [], listener])
	}
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: browserMock })
	Object.defineProperty(globalThis, 'addEventListener', { configurable: true, writable: true, value: addEventListener })
	const scriptContainer = {
		children: [{}, {}],
		insertBefore: () => undefined,
		removeChild: () => undefined,
	}
	Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
		head: scriptContainer,
		documentElement: scriptContainer,
		createElement: () => ({
			setAttribute: () => undefined,
			src: '',
			textContent: '',
		}),
	} })

	try {
		if (source === 'manifest-v2-document-start') await import('../../app/inpage/ts/document_start.js?manifest-v2-background-port-recovery')
		else await import('../../app/inpage/ts/listenContentScript.js?background-port-recovery')
		await run({ backgroundMessageListeners, runtimeMessageListeners, disconnectListeners, eventListeners, postedMessages, connectionNames, runtime, getConnectionCount: () => connectionCount, failNextPost: () => { shouldFailNextPost = true } })
	} finally {
		if (browserDescriptor === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', browserDescriptor)
		if (addEventListenerDescriptor === undefined) Reflect.deleteProperty(globalThis, 'addEventListener')
		else Object.defineProperty(globalThis, 'addEventListener', addEventListenerDescriptor)
		if (documentDescriptor === undefined) Reflect.deleteProperty(globalThis, 'document')
		else Object.defineProperty(globalThis, 'document', documentDescriptor)
		if (interceptorInjectedDescriptor === undefined) Reflect.deleteProperty(globalThis, 'interceptorInjected')
		else Object.defineProperty(globalThis, 'interceptorInjected', interceptorInjectedDescriptor)
	}
}

function dispatchWindowMessage(eventListeners: Map<string, EventListenerOrEventListenerObject[]>, event: MessageEvent) {
	for (const listener of eventListeners.get('message') ?? []) {
		if (typeof listener === 'function') listener(event)
		else listener.handleEvent(event)
	}
}

async function dispatchBridgeRequest(eventListeners: Map<string, EventListenerOrEventListenerObject[]>) {
	const channel = new MessageChannel()
	dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port' }, ports: [channel.port2] }))
	channel.port1.postMessage({
		type: 'interceptor_bridge_request',
		method: 'eth_sendTransaction',
		params: [],
		usingInterceptorWithoutSigner: false,
		requestId: 1,
	})
	await new Promise((resolve) => setTimeout(resolve, 0))
	channel.port1.close()
	channel.port2.close()
}

async function verifyContentScriptReconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, runtimeMessageListeners, disconnectListeners, eventListeners, postedMessages, connectionNames, runtime, getConnectionCount, failNextPost }) => {
		assert.equal(getConnectionCount(), 1)
		assert.equal(disconnectListeners.length, 1)

		disconnectListeners[0]?.()

		assert.equal(getConnectionCount(), 2)
		assert.equal(disconnectListeners.length, 2)

		failNextPost()
		await dispatchBridgeRequest(eventListeners)

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 1)
		assert.equal(disconnectListeners.length, 3)

		disconnectListeners[1]?.()
		assert.equal(getConnectionCount(), 3)

		const originalConsoleError = console.error
		console.error = () => undefined
		try {
			failNextPost()
			backgroundMessageListeners[2]?.({ malformed: true })
		} finally {
			console.error = originalConsoleError
		}
		assert.equal(getConnectionCount(), 4)
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(await runtimeMessageListeners[0]?.({
			method: 'interceptor_reconnect_content_script_port',
			connectionName: connectionNames[0],
		}), { reconnected: true })
		assert.equal(getConnectionCount(), 5)
		assert.equal(new Set(connectionNames).size, 1)

		runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }
		disconnectListeners[4]?.()

		assert.equal(getConnectionCount(), 5)
		await new Promise((resolve) => setTimeout(resolve, 300))
		assert.equal(getConnectionCount(), 6)
		assert.equal(disconnectListeners.length, 6)
		assert.equal(new Set(connectionNames).size, 1)

		runtime.lastError = { message: 'Extension context invalidated' }
		disconnectListeners[5]?.()
		await new Promise((resolve) => setTimeout(resolve, 150))

		assert.equal(getConnectionCount(), 6)
	})
}

test('standalone content script recovers its background port without reconnect churn', async () => {
	await verifyContentScriptReconnect('standalone-listener')
})

test('manifest v2 document-start content script recovers its background port without reconnect churn', async () => {
	await verifyContentScriptReconnect('manifest-v2-document-start')
})

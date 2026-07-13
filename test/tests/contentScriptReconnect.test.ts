import * as assert from 'assert'
import { test } from 'bun:test'

type ContentScriptMockState = {
	readonly backgroundMessageListeners: ((message: unknown) => void)[]
	readonly disconnectListeners: (() => void)[]
	readonly eventListeners: Map<string, EventListenerOrEventListenerObject[]>
	readonly postedMessages: unknown[]
	readonly runtime: { lastError: { message?: string } | undefined }
	readonly getConnectionCount: () => number
	readonly failNextPost: () => void
}

async function withContentScriptMock(run: (state: ContentScriptMockState) => Promise<void>) {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
	const backgroundMessageListeners: ((message: unknown) => void)[] = []
	const disconnectListeners: (() => void)[] = []
	const eventListeners = new Map<string, EventListenerOrEventListenerObject[]>()
	const postedMessages: unknown[] = []
	const runtime: { lastError: { message?: string } | undefined } = { lastError: undefined }
	let connectionCount = 0
	let shouldFailNextPost = false

	const browserMock = {
		runtime: {
			get lastError() { return runtime.lastError },
			connect: () => {
				connectionCount += 1
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
		},
	}
	const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		eventListeners.set(type, [...eventListeners.get(type) ?? [], listener])
	}
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: browserMock })
	Object.defineProperty(globalThis, 'addEventListener', { configurable: true, writable: true, value: addEventListener })

	try {
		await import('../../app/inpage/ts/listenContentScript.js?background-port-recovery')
		await run({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, runtime, getConnectionCount: () => connectionCount, failNextPost: () => { shouldFailNextPost = true } })
	} finally {
		if (browserDescriptor === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', browserDescriptor)
		if (addEventListenerDescriptor === undefined) Reflect.deleteProperty(globalThis, 'addEventListener')
		else Object.defineProperty(globalThis, 'addEventListener', addEventListenerDescriptor)
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

test('content script recovers its background port without reconnect churn', async () => {
	await withContentScriptMock(async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, runtime, getConnectionCount, failNextPost }) => {
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

		runtime.lastError = { message: 'Extension context invalidated' }
		disconnectListeners[3]?.()

		assert.equal(getConnectionCount(), 4)
	})
})

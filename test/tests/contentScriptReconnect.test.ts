import * as assert from 'assert'
import { test } from 'bun:test'
import { acknowledgeAndTrackBridgeRequest, INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE } from '../../app/ts/background/bridgeRequestDelivery.js'

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
let contentScriptMockImportId = 0
const contentScriptListenerGlobalKey = Symbol.for('TheInterceptor.listenContentScript')
const BRIDGE_CAPABILITY = '11111111-1111-4111-8111-111111111111'

async function withContentScriptMock(source: ContentScriptSource, run: (state: ContentScriptMockState) => Promise<void>, legacyListenerDescriptor: PropertyDescriptor | undefined = undefined) {
	const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
	const interceptorInjectedDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'interceptorInjected')
	const contentScriptListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, contentScriptListenerGlobalKey)
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
	if (legacyListenerDescriptor !== undefined) Object.defineProperty(globalThis, 'listenContentScript', legacyListenerDescriptor)
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
		contentScriptMockImportId += 1
		await import(`../../app/inpage/ts/listenContentScript.js?shared-background-port-recovery-${ contentScriptMockImportId }`)
		if (source === 'manifest-v2-document-start') await import(`../../app/inpage/ts/document_start.js?manifest-v2-background-port-recovery-${ contentScriptMockImportId }`)
		else await import(`../../app/inpage/ts/listenContentScriptBootstrap.js?background-port-recovery-${ contentScriptMockImportId }`)
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
		if (contentScriptListenerDescriptor === undefined) Reflect.deleteProperty(globalThis, contentScriptListenerGlobalKey)
		else Object.defineProperty(globalThis, contentScriptListenerGlobalKey, contentScriptListenerDescriptor)
	}
}

function dispatchWindowMessage(eventListeners: Map<string, EventListenerOrEventListenerObject[]>, event: MessageEvent) {
	for (const listener of eventListeners.get('message') ?? []) {
		if (typeof listener === 'function') listener(event)
		else listener.handleEvent(event)
	}
}

function getPostedBridgeRequestId(value: unknown) {
	if (typeof value !== 'object' || value === null || !('data' in value)) return undefined
	const data = value.data
	if (typeof data !== 'object' || data === null || !('requestId' in data) || typeof data.requestId !== 'number') return undefined
	return data.requestId
}

function getContentScriptCapability(receivedMessages: readonly unknown[]) {
	const initializationMessage = receivedMessages.find((message) => typeof message === 'object'
		&& message !== null
		&& 'type' in message
		&& message.type === 'interceptor_bridge_initialized')
	if (typeof initializationMessage !== 'object'
		|| initializationMessage === null
		|| !('contentScriptCapability' in initializationMessage)
		|| typeof initializationMessage.contentScriptCapability !== 'string') throw new Error('Missing content-script bridge capability')
	return initializationMessage.contentScriptCapability
}

async function dispatchBridgeRequest(eventListeners: Map<string, EventListenerOrEventListenerObject[]>, method = 'eth_sendTransaction', replayOnDisconnect = false, keepBridgeOpen = false) {
	const channel = new MessageChannel()
	const receivedMessages: unknown[] = []
	channel.port1.onmessage = (event: MessageEvent<unknown>) => receivedMessages.push(event.data)
	dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port', bridgeCapability: BRIDGE_CAPABILITY }, ports: [channel.port2] }))
	channel.port1.postMessage({
		type: 'interceptor_bridge_request',
		bridgeCapability: BRIDGE_CAPABILITY,
		method,
		params: [],
		usingInterceptorWithoutSigner: false,
		requestId: 1,
		...(replayOnDisconnect ? { replayOnDisconnect: true } : {}),
	})
	await new Promise((resolve) => setTimeout(resolve, 0))
	const close = () => {
		channel.port1.close()
		channel.port2.close()
	}
	if (!keepBridgeOpen) close()
	return { receivedMessages, close }
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
		backgroundMessageListeners[2]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })

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

async function verifyRequestQueuedDuringReconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ disconnectListeners, eventListeners, postedMessages, runtimeMessageListeners, connectionNames, runtime, getConnectionCount }) => {
		runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }
		disconnectListeners[0]?.()
		assert.equal(getConnectionCount(), 1)

		await dispatchBridgeRequest(eventListeners)
		assert.deepEqual(postedMessages, [])

		runtime.lastError = undefined
		assert.deepEqual(await runtimeMessageListeners[0]?.({
			method: 'interceptor_reconnect_content_script_port',
			connectionName: connectionNames[0],
		}), { reconnected: true })
		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			method: 'eth_sendTransaction',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
	})
}

async function verifyUnacknowledgedRequestReplayedAfterDisconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners)
		assert.equal(postedMessages.length, 1)

		disconnectListeners[0]?.()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], postedMessages[0])

		backgroundMessageListeners[1]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		disconnectListeners[1]?.()
		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
	})
}

async function verifyAcknowledgedReplayableRequestReplayedUntilMarkedSettled(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, getConnectionCount }) => {
		const inpageBridge = await dispatchBridgeRequest(eventListeners, 'example_replayableMethod', true, true)
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			method: 'example_replayableMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		backgroundMessageListeners[0]?.({ interceptorApproved: true, type: 'result', method: 'example_intermediateEvent', requestId: 1, result: [] })

		disconnectListeners[0]?.()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], postedMessages[0])
		backgroundMessageListeners[1]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		backgroundMessageListeners[1]?.({
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
			bridgeRequestSettled: true,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(inpageBridge.receivedMessages.at(-1), {
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
			contentScriptCapability: getContentScriptCapability(inpageBridge.receivedMessages),
		})

		disconnectListeners[1]?.()

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
		inpageBridge.close()
	})
}

async function verifyRpcMethodDoesNotImplicitlyEnableReplay(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners, 'eth_requestAccounts')
		assert.equal(postedMessages.length, 1)
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })

		disconnectListeners[0]?.()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 1)
	})
}

async function verifyRetainedRequestsReplayBeforeNewerPendingRequests(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages }) => {
		const channel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port', bridgeCapability: BRIDGE_CAPABILITY }, ports: [channel.port2] }))
		channel.port1.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: BRIDGE_CAPABILITY,
			method: 'example_replayableMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
			replayOnDisconnect: true,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		channel.port1.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: BRIDGE_CAPABILITY,
			method: 'example_pendingMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 2,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(postedMessages.map(getPostedBridgeRequestId), [1, 2])

		disconnectListeners[0]?.()

		assert.deepEqual(postedMessages.map(getPostedBridgeRequestId), [1, 2, 1])
		backgroundMessageListeners[1]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		assert.deepEqual(postedMessages.map(getPostedBridgeRequestId), [1, 2, 1, 2])

		const latestReceivedRequestIds = new Map<string, number>()
		const replayHandling = postedMessages.slice(2).map((message) => {
			const requestId = getPostedBridgeRequestId(message)
			if (requestId === undefined) throw new Error('Missing replayed bridge request ID')
			return acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'replacement-socket', requestId, () => undefined)
		})
		assert.deepEqual(replayHandling, [true, true])
		channel.port1.close()
		channel.port2.close()
	})
}

async function verifySettlementRemovesInFlightReplay(source: ContentScriptSource, settleFromStalePort: boolean) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners, 'example_replayableMethod', true)
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		disconnectListeners[0]?.()
		assert.equal(postedMessages.length, 2)

		const settlementPortIndex = settleFromStalePort ? 0 : 1
		backgroundMessageListeners[settlementPortIndex]?.({
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
			bridgeRequestSettled: true,
		})
		disconnectListeners[1]?.()

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
	})
}

async function verifyAcknowledgementAdvancesQueuedRequests(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners, postedMessages, getConnectionCount }) => {
		const channel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port', bridgeCapability: BRIDGE_CAPABILITY }, ports: [channel.port2] }))
		for (const requestId of [1, 2]) {
			channel.port1.postMessage({
				type: 'interceptor_bridge_request',
				bridgeCapability: BRIDGE_CAPABILITY,
				method: 'eth_sendTransaction',
				params: [],
				usingInterceptorWithoutSigner: false,
				requestId,
			})
		}
		await new Promise((resolve) => setTimeout(resolve, 0))

		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			method: 'eth_sendTransaction',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 2 })
		assert.equal(postedMessages.length, 1)
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], { data: {
			interceptorRequest: true,
			method: 'eth_sendTransaction',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 2,
		} })
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 2 })

		disconnectListeners[0]?.()
		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		channel.port1.close()
		channel.port2.close()
	})
}

async function verifyStalePortAcknowledgementIsIgnored(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, postedMessages, getConnectionCount }) => {
		disconnectListeners[0]?.()
		assert.equal(getConnectionCount(), 2)

		const originalConsoleError = console.error
		const consoleErrors: unknown[][] = []
		console.error = (...args: unknown[]) => consoleErrors.push(args)
		try {
			backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		} finally {
			console.error = originalConsoleError
		}

		assert.deepEqual(consoleErrors, [])
		assert.deepEqual(postedMessages, [])
	})
}

async function verifyEstablishedBridgeRejectsForgedInternalRequests(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, eventListeners, postedMessages }) => {
		const legitimateChannel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', {
			data: { type: 'interceptor_bridge_port', bridgeCapability: BRIDGE_CAPABILITY },
			ports: [legitimateChannel.port2],
		}))
		legitimateChannel.port1.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: BRIDGE_CAPABILITY,
			method: 'signer_providers_changed',
			params: [[], false, BRIDGE_CAPABILITY],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
			internal: true,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			interceptorInternalRequest: true,
			method: 'signer_providers_changed',
			params: [[], false, BRIDGE_CAPABILITY],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })

		const forgedCapability = '22222222-2222-4222-8222-222222222222'
		const forgedChannel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', {
			data: { type: 'interceptor_bridge_port', bridgeCapability: forgedCapability },
			ports: [forgedChannel.port2],
		}))
		forgedChannel.port1.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: forgedCapability,
			method: 'signer_provider_selected',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 2,
			internal: true,
		})
		// An observer only sees the content-side endpoint. Posting on it sends toward
		// the inpage endpoint and cannot inject a request toward the extension.
		legitimateChannel.port2.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: BRIDGE_CAPABILITY,
			method: 'signer_provider_selected',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 3,
			internal: true,
		})
		legitimateChannel.port1.postMessage({
			type: 'interceptor_bridge_request',
			bridgeCapability: forgedCapability,
			method: 'signer_provider_selected',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 4,
			internal: true,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(postedMessages.length, 1)

		legitimateChannel.port1.close()
		legitimateChannel.port2.close()
		forgedChannel.port1.close()
		forgedChannel.port2.close()
	})
}

async function verifyInpageIsNotifiedAfterBackgroundBridgeReconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ backgroundMessageListeners, disconnectListeners, eventListeners }) => {
		const inpageBridge = await dispatchBridgeRequest(eventListeners, 'signer_providers_changed', false, true)
		backgroundMessageListeners[0]?.({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		disconnectListeners[0]?.()
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(inpageBridge.receivedMessages.at(-1), {
			type: 'interceptor_bridge_reconnected',
			bridgeCapability: BRIDGE_CAPABILITY,
			contentScriptCapability: getContentScriptCapability(inpageBridge.receivedMessages),
		})
		inpageBridge.close()
	})
}

async function verifyContentScriptStartsWithoutRandomUuid() {
	const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
	const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
	Object.defineProperty(globalThis, 'crypto', {
		configurable: true,
		value: { getRandomValues },
	})
	try {
		await withContentScriptMock('standalone-listener', async ({ eventListeners, getConnectionCount }) => {
			assert.equal(getConnectionCount(), 1)
			const inpageBridge = await dispatchBridgeRequest(eventListeners, 'signer_providers_changed', false, true)
			assert.match(getContentScriptCapability(inpageBridge.receivedMessages), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
			inpageBridge.close()
		})
	} finally {
		if (cryptoDescriptor === undefined) Reflect.deleteProperty(globalThis, 'crypto')
		else Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
	}
}

if (process.env.INTERCEPTOR_CONTENT_SCRIPT_RECONNECT_TEST_CHILD === 'true') {
	test('content script starts without crypto.randomUUID on insecure pages', async () => {
		await verifyContentScriptStartsWithoutRandomUuid()
	})

	test('standalone content script recovers its background port without reconnect churn', async () => {
		await verifyContentScriptReconnect('standalone-listener')
	})

	test('manifest v2 document-start content script recovers its background port without reconnect churn', async () => {
		await verifyContentScriptReconnect('manifest-v2-document-start')
	})

	test('standalone content script queues requests while its background port reconnects', async () => {
		await verifyRequestQueuedDuringReconnect('standalone-listener')
	})

	test('manifest v2 document-start queues requests while its background port reconnects', async () => {
		await verifyRequestQueuedDuringReconnect('manifest-v2-document-start')
	})

	test('standalone content script replays an unacknowledged request after disconnect', async () => {
		await verifyUnacknowledgedRequestReplayedAfterDisconnect('standalone-listener')
	})

	test('manifest v2 document-start replays an unacknowledged request after disconnect', async () => {
		await verifyUnacknowledgedRequestReplayedAfterDisconnect('manifest-v2-document-start')
	})

	test('standalone content script replays an acknowledged flagged request until a marked terminal reply', async () => {
		await verifyAcknowledgedReplayableRequestReplayedUntilMarkedSettled('standalone-listener')
	})

	test('manifest v2 document-start replays an acknowledged flagged request until a marked terminal reply', async () => {
		await verifyAcknowledgedReplayableRequestReplayedUntilMarkedSettled('manifest-v2-document-start')
	})

	test('standalone content script does not infer replay policy from the RPC method', async () => {
		await verifyRpcMethodDoesNotImplicitlyEnableReplay('standalone-listener')
	})

	test('manifest v2 document-start does not infer replay policy from the RPC method', async () => {
		await verifyRpcMethodDoesNotImplicitlyEnableReplay('manifest-v2-document-start')
	})

	test('standalone content script replays retained requests before newer pending requests', async () => {
		await verifyRetainedRequestsReplayBeforeNewerPendingRequests('standalone-listener')
	})

	test('manifest v2 document-start replays retained requests before newer pending requests', async () => {
		await verifyRetainedRequestsReplayBeforeNewerPendingRequests('manifest-v2-document-start')
	})

	test('standalone content script removes an in-flight replay when its terminal reply arrives before acknowledgement', async () => {
		await verifySettlementRemovesInFlightReplay('standalone-listener', false)
	})

	test('manifest v2 document-start removes an in-flight replay when its terminal reply arrives before acknowledgement', async () => {
		await verifySettlementRemovesInFlightReplay('manifest-v2-document-start', false)
	})

	test('standalone content script accepts settlement from a stale port while the replay is in flight', async () => {
		await verifySettlementRemovesInFlightReplay('standalone-listener', true)
	})

	test('manifest v2 document-start accepts settlement from a stale port while the replay is in flight', async () => {
		await verifySettlementRemovesInFlightReplay('manifest-v2-document-start', true)
	})

	test('standalone content script advances queued requests only after the matching acknowledgement', async () => {
		await verifyAcknowledgementAdvancesQueuedRequests('standalone-listener')
	})

	test('manifest v2 document-start advances queued requests only after the matching acknowledgement', async () => {
		await verifyAcknowledgementAdvancesQueuedRequests('manifest-v2-document-start')
	})

	test('standalone content script ignores acknowledgements from a stale port without diagnostics', async () => {
		await verifyStalePortAcknowledgementIsIgnored('standalone-listener')
	})

	test('manifest v2 document-start ignores acknowledgements from a stale port without diagnostics', async () => {
		await verifyStalePortAcknowledgementIsIgnored('manifest-v2-document-start')
	})

	test('standalone content script rejects forged internal requests after bridge establishment', async () => {
		await verifyEstablishedBridgeRejectsForgedInternalRequests('standalone-listener')
	})

	test('manifest v2 document-start rejects forged internal requests after bridge establishment', async () => {
		await verifyEstablishedBridgeRejectsForgedInternalRequests('manifest-v2-document-start')
	})

	test('standalone content script notifies inpage after its background bridge reconnects', async () => {
		await verifyInpageIsNotifiedAfterBackgroundBridgeReconnect('standalone-listener')
	})

	test('manifest v2 document-start notifies inpage after its background bridge reconnects', async () => {
		await verifyInpageIsNotifiedAfterBackgroundBridgeReconnect('manifest-v2-document-start')
	})

	test('does not redefine a non-configurable legacy content script listener', async () => {
		const legacyListener = () => undefined
		await withContentScriptMock('standalone-listener', async ({ getConnectionCount }) => {
			assert.equal(Reflect.get(globalThis, 'listenContentScript'), legacyListener)
			assert.equal(getConnectionCount(), 1)
		}, { configurable: false, value: legacyListener })
	})
} else {
	test('content script reconnect scenarios pass in an isolated browser-global harness', async () => {
		const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
			env: { ...process.env, INTERCEPTOR_CONTENT_SCRIPT_RECONNECT_TEST_CHILD: 'true' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		assert.equal(exitCode, 0, `Isolated content-script reconnect tests failed.\n${ stdout }\n${ stderr }`)
	})
}

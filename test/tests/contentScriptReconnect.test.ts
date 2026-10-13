import * as assert from 'node:assert'
import { test } from 'bun:test'
import { acknowledgeAndTrackBridgeRequest, INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE } from '../../app/ts/background/bridgeRequestDelivery.js'
import { flushMicrotasks } from '../harness/async.js'
import { createMockEvent, installBrowserMock } from '../harness/browserMock.js'
import { replaceGlobal, replaceProperty } from '../harness/globals.js'
import { installManualTimers, type ManualTimers } from '../harness/timers.js'

type ContentScriptPortControls = {
	// Delivers a message from the background end. Unlike harness ports, it still delivers after a disconnect, so scenarios can model replies that a replaced background port sends late.
	readonly receive: (message: unknown) => void
	// Fires the content script's onDisconnect listeners, as if the background end had disconnected.
	readonly disconnect: () => void
}

type ContentScriptMockState = {
	readonly port: (index: number) => ContentScriptPortControls
	readonly eventListeners: Map<string, EventListenerOrEventListenerObject[]>
	readonly postedMessages: unknown[]
	readonly connectionNames: () => string[]
	readonly getConnectionCount: () => number
	readonly disconnectListenerCount: () => number
	readonly setLastError: (lastError: browser.runtime._LastError | undefined) => void
	readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>
	readonly failNextPost: () => void
	readonly timers: Pick<ManualTimers, 'pendingCount' | 'runPending'>
}

type ContentScriptSource = 'manifest-v2-document-start' | 'standalone-listener'
let contentScriptMockImportId = 0
const contentScriptListenerGlobalKey = Symbol.for('TheInterceptor.listenContentScript')

async function withContentScriptMock(source: ContentScriptSource, run: (state: ContentScriptMockState) => Promise<void>, legacyListenerDescriptor: PropertyDescriptor | undefined = undefined) {
	const browserMock = installBrowserMock()
	// The reconnect delay is a fixed timer inside listenContentScript.ts, so scenarios decide when pending timers run instead of sleeping past the delay.
	const timers = installManualTimers()
	const eventListeners = new Map<string, EventListenerOrEventListenerObject[]>()
	const postedMessages: unknown[] = []
	const ports: { readonly port: browser.runtime.Port, readonly controls: ContentScriptPortControls, readonly hasDisconnectListener: () => boolean }[] = []
	let shouldFailNextPost = false

	// Content scripts connect through browser.runtime.connect; these ports are built from harness events so they can keep delivering after a disconnect.
	browserMock.browser.runtime.connect = (connectInfo = {}) => {
		const onMessage = createMockEvent<[message: unknown]>()
		const onDisconnect = createMockEvent<[port: browser.runtime.Port]>()
		const port: browser.runtime.Port = {
			name: connectInfo.name ?? '',
			disconnect: () => undefined,
			onMessage,
			onDisconnect,
			postMessage: (message: unknown) => {
				if (shouldFailNextPost) {
					shouldFailNextPost = false
					throw new Error('Attempting to use a disconnected port object')
				}
				postedMessages.push(message)
			},
		}
		ports.push({
			port,
			controls: { receive: (message) => { onMessage.dispatch(message) }, disconnect: () => { onDisconnect.dispatch(port) } },
			hasDisconnectListener: onDisconnect.hasListeners,
		})
		return port
	}
	const addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
		eventListeners.set(type, [...eventListeners.get(type) ?? [], listener])
	}
	const scriptContainer = {
		children: [{}, {}],
		insertBefore: () => undefined,
		removeChild: () => undefined,
	}
	const restoreGlobals = [
		browserMock.restore,
		timers.restore,
		replaceGlobal('addEventListener', addEventListener),
		replaceGlobal('document', {
			head: scriptContainer,
			documentElement: scriptContainer,
			createElement: () => ({
				setAttribute: () => undefined,
				src: '',
				textContent: '',
			}),
		}),
		// The content scripts define these globals; replacing them first makes the restore below remove what each scenario defined.
		replaceGlobal('interceptorInjected', undefined),
		replaceGlobal(contentScriptListenerGlobalKey, undefined),
	]
	if (legacyListenerDescriptor !== undefined) Object.defineProperty(globalThis, 'listenContentScript', legacyListenerDescriptor)

	try {
		contentScriptMockImportId += 1
		await import(`../../app/inpage/ts/listenContentScript.js?shared-background-port-recovery-${ contentScriptMockImportId }`)
		if (source === 'manifest-v2-document-start') await import(`../../app/inpage/ts/document_start.js?manifest-v2-background-port-recovery-${ contentScriptMockImportId }`)
		else await import(`../../app/inpage/ts/listenContentScriptBootstrap.js?background-port-recovery-${ contentScriptMockImportId }`)
		await run({
			port: (index) => {
				const contentScriptPort = ports[index]
				if (contentScriptPort === undefined) throw new Error(`The content script has not opened background port ${ index }`)
				return contentScriptPort.controls
			},
			eventListeners,
			postedMessages,
			connectionNames: () => ports.map(({ port }) => port.name),
			getConnectionCount: () => ports.length,
			disconnectListenerCount: () => ports.filter(({ hasDisconnectListener }) => hasDisconnectListener()).length,
			setLastError: (lastError) => { browserMock.browser.runtime.lastError = lastError },
			sendRuntimeMessage: async (message) => await browserMock.dispatchRuntimeMessage(message),
			failNextPost: () => { shouldFailNextPost = true },
			timers,
		})
	} finally {
		for (const restoreGlobal of restoreGlobals.reverse()) restoreGlobal()
	}
}

function dispatchWindowMessage(eventListeners: Map<string, EventListenerOrEventListenerObject[]>, event: MessageEvent) {
	for (const listener of eventListeners.get('message') ?? []) {
		if (typeof listener === 'function') listener(event)
		else listener.handleEvent(event)
	}
}

// Bun delivers queued MessagePort messages before setImmediate callbacks run, so flushing lets the content script and the inpage bridge receive what was posted. Scenarios replace setTimeout, so this cannot sleep on a timer.
async function waitForMessagePortDelivery() {
	await flushMicrotasks()
}

function getPostedBridgeRequestId(value: unknown) {
	if (typeof value !== 'object' || value === null || !('data' in value)) return undefined
	const data = value.data
	if (typeof data !== 'object' || data === null || !('requestId' in data) || typeof data.requestId !== 'number') return undefined
	return data.requestId
}

async function dispatchBridgeRequest(eventListeners: Map<string, EventListenerOrEventListenerObject[]>, method = 'eth_sendTransaction', replayOnDisconnect = false, keepBridgeOpen = false) {
	const channel = new MessageChannel()
	const receivedMessages: unknown[] = []
	channel.port1.onmessage = (event: MessageEvent<unknown>) => receivedMessages.push(event.data)
	dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port' }, ports: [channel.port2] }))
	channel.port1.postMessage({
		type: 'interceptor_bridge_request',
		method,
		params: [],
		usingInterceptorWithoutSigner: false,
		requestId: 1,
		...(replayOnDisconnect ? { replayOnDisconnect: true } : {}),
	})
	await waitForMessagePortDelivery()
	const close = () => {
		channel.port1.close()
		channel.port2.close()
	}
	if (!keepBridgeOpen) close()
	return { receivedMessages, close }
}

async function verifyContentScriptReconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, sendRuntimeMessage, disconnectListenerCount, eventListeners, postedMessages, connectionNames, setLastError, getConnectionCount, failNextPost, timers }) => {
		assert.equal(getConnectionCount(), 1)
		assert.equal(disconnectListenerCount(), 1)

		port(0).disconnect()

		assert.equal(getConnectionCount(), 2)
		assert.equal(disconnectListenerCount(), 2)

		failNextPost()
		await dispatchBridgeRequest(eventListeners)

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 1)
		assert.equal(disconnectListenerCount(), 3)
		port(2).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })

		port(1).disconnect()
		assert.equal(getConnectionCount(), 3)

		const restoreConsoleError = replaceProperty(console, 'error', () => undefined)
		try {
			failNextPost()
			port(2).receive({ malformed: true })
		} finally {
			restoreConsoleError()
		}
		assert.equal(getConnectionCount(), 4)
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(await sendRuntimeMessage({
			method: 'interceptor_reconnect_content_script_port',
			connectionName: connectionNames()[0],
		}), { reconnected: true })
		assert.equal(getConnectionCount(), 5)
		assert.equal(new Set(connectionNames()).size, 1)

		setLastError({ message: 'Could not establish connection. Receiving end does not exist.' })
		port(4).disconnect()

		// A missing receiver reconnects after a delay instead of immediately.
		assert.equal(getConnectionCount(), 5)
		assert.equal(timers.pendingCount(), 1)
		timers.runPending()
		assert.equal(getConnectionCount(), 6)
		assert.equal(disconnectListenerCount(), 6)
		assert.equal(new Set(connectionNames()).size, 1)

		// An invalidated extension context is terminal, so no reconnect is attempted or scheduled.
		setLastError({ message: 'Extension context invalidated' })
		port(5).disconnect()
		assert.equal(timers.pendingCount(), 0)

		assert.equal(getConnectionCount(), 6)
	})
}

async function verifyRequestQueuedDuringReconnect(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, sendRuntimeMessage, connectionNames, setLastError, getConnectionCount }) => {
		setLastError({ message: 'Could not establish connection. Receiving end does not exist.' })
		port(0).disconnect()
		assert.equal(getConnectionCount(), 1)

		await dispatchBridgeRequest(eventListeners)
		assert.deepEqual(postedMessages, [])

		setLastError(undefined)
		assert.deepEqual(await sendRuntimeMessage({
			method: 'interceptor_reconnect_content_script_port',
			connectionName: connectionNames()[0],
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
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners)
		assert.equal(postedMessages.length, 1)

		port(0).disconnect()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], postedMessages[0])

		port(1).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		port(1).disconnect()
		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
	})
}

async function verifyAcknowledgedReplayableRequestReplayedUntilMarkedSettled(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, getConnectionCount }) => {
		const inpageBridge = await dispatchBridgeRequest(eventListeners, 'example_replayableMethod', true, true)
		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			method: 'example_replayableMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		port(0).receive({ interceptorApproved: true, type: 'result', method: 'example_intermediateEvent', requestId: 1, result: [] })

		port(0).disconnect()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], postedMessages[0])
		port(1).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		port(1).receive({
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
			bridgeRequestSettled: true,
		})
		await waitForMessagePortDelivery()
		assert.deepEqual(inpageBridge.receivedMessages.at(-1), {
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
		})

		port(1).disconnect()

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
		inpageBridge.close()
	})
}

async function verifyRpcMethodDoesNotImplicitlyEnableReplay(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners, 'eth_requestAccounts')
		assert.equal(postedMessages.length, 1)
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })

		port(0).disconnect()

		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 1)
	})
}

async function verifyRetainedRequestsReplayBeforeNewerPendingRequests(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages }) => {
		const channel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port' }, ports: [channel.port2] }))
		channel.port1.postMessage({
			type: 'interceptor_bridge_request',
			method: 'example_replayableMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
			replayOnDisconnect: true,
		})
		await waitForMessagePortDelivery()
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		channel.port1.postMessage({
			type: 'interceptor_bridge_request',
			method: 'example_pendingMethod',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 2,
		})
		await waitForMessagePortDelivery()
		assert.deepEqual(postedMessages.map(getPostedBridgeRequestId), [1, 2])

		port(0).disconnect()

		assert.deepEqual(postedMessages.map(getPostedBridgeRequestId), [1, 2, 1])
		port(1).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
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
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, getConnectionCount }) => {
		await dispatchBridgeRequest(eventListeners, 'example_replayableMethod', true)
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		port(0).disconnect()
		assert.equal(postedMessages.length, 2)

		const settlementPortIndex = settleFromStalePort ? 0 : 1
		port(settlementPortIndex).receive({
			interceptorApproved: true,
			type: 'result',
			method: 'example_terminalReply',
			requestId: 1,
			result: [],
			bridgeRequestSettled: true,
		})
		port(1).disconnect()

		assert.equal(getConnectionCount(), 3)
		assert.equal(postedMessages.length, 2)
	})
}

async function verifyAcknowledgementAdvancesQueuedRequests(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, eventListeners, postedMessages, getConnectionCount }) => {
		const channel = new MessageChannel()
		dispatchWindowMessage(eventListeners, new MessageEvent('message', { data: { type: 'interceptor_bridge_port' }, ports: [channel.port2] }))
		for (const requestId of [1, 2]) {
			channel.port1.postMessage({
				type: 'interceptor_bridge_request',
				method: 'eth_sendTransaction',
				params: [],
				usingInterceptorWithoutSigner: false,
				requestId,
			})
		}
		await waitForMessagePortDelivery()

		assert.equal(postedMessages.length, 1)
		assert.deepEqual(postedMessages[0], { data: {
			interceptorRequest: true,
			method: 'eth_sendTransaction',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 1,
		} })
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 2 })
		assert.equal(postedMessages.length, 1)
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		assert.equal(postedMessages.length, 2)
		assert.deepEqual(postedMessages[1], { data: {
			interceptorRequest: true,
			method: 'eth_sendTransaction',
			params: [],
			usingInterceptorWithoutSigner: false,
			requestId: 2,
		} })
		port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 2 })

		port(0).disconnect()
		assert.equal(getConnectionCount(), 2)
		assert.equal(postedMessages.length, 2)
		channel.port1.close()
		channel.port2.close()
	})
}

async function verifyStalePortAcknowledgementIsIgnored(source: ContentScriptSource) {
	await withContentScriptMock(source, async ({ port, postedMessages, getConnectionCount }) => {
		port(0).disconnect()
		assert.equal(getConnectionCount(), 2)

		const consoleErrors: unknown[][] = []
		const restoreConsoleError = replaceProperty(console, 'error', (...args: unknown[]) => { consoleErrors.push(args) })
		try {
			port(0).receive({ type: INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE, requestId: 1 })
		} finally {
			restoreConsoleError()
		}

		assert.deepEqual(consoleErrors, [])
		assert.deepEqual(postedMessages, [])
	})
}

if (process.env.INTERCEPTOR_CONTENT_SCRIPT_RECONNECT_TEST_CHILD === 'true') {
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

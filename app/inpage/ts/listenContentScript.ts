const contentScriptListenerGlobalKey = Symbol.for('TheInterceptor.listenContentScript')

function listenContentScript(connectionName: string | undefined, diagnosticsSource: 'content-script' | 'document-start') {
	const INTERCEPTOR_BRIDGE_PORT_MESSAGE = 'interceptor_bridge_port'
	const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
	const INTERCEPTOR_BRIDGE_INITIALIZED_MESSAGE = 'interceptor_bridge_initialized'
	const INTERCEPTOR_BRIDGE_RECONNECTED_MESSAGE = 'interceptor_bridge_reconnected'
	// This non-module inpage build cannot import the canonical background constant from bridgeRequestDelivery.ts; contentScriptReconnect.test.ts enforces that both values match.
	const INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE = 'interceptor_bridge_acknowledgement'
	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
	}
	type ForwardedDiagnosticsRequestContext = {
		readonly requestId?: number
		readonly requestMethod?: string
	}
	const stringifyForwardedFallbackError = (error: unknown) => error instanceof Error ? `${ error.name }: ${ error.message }` : `Unexpected thrown value: ${ String(error) }`
	const stringifyForwardedFallbackValue = (value: unknown) => {
		try {
			return String(value)
		} catch (error: unknown) {
			return `[failed to stringify value: ${ stringifyForwardedFallbackError(error) }]`
		}
	}

	/**
	 * this script executed within the context of the active tab when the user clicks the extension bar button
	 * this script serves as a _very thin_ proxy between the page scripts (dapp) and the extension, simply forwarding messages between the two
	*/
	// the content script is a very thin proxy between the background script and the page script

	const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

	function generateId (len: number) {
		const arr = new Uint8Array((len || 40) / 2)
		globalThis.crypto.getRandomValues(arr)
		return `0x${ Array.from(arr, dec2hex).join('') }`
	}
	const generateUuidV4 = () => {
		const bytes = new Uint8Array(16)
		globalThis.crypto.getRandomValues(bytes)
		bytes[6] = (bytes[6] & 0x0f) | 0x40
		bytes[8] = (bytes[8] & 0x3f) | 0x80
		const hex = Array.from(bytes, dec2hex).join('')
		return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-${ hex.slice(12, 16) }-${ hex.slice(16, 20) }-${ hex.slice(20) }`
	}
	const connectionNameNotUndefined = connectionName === undefined ? generateId(40) : connectionName
	let pageHidden = false
	let extensionPort: browser.runtime.Port | undefined 
	let inpagePort: MessagePort | undefined
	let inpageBridgeCapability: string | undefined
	const contentScriptCapability = generateUuidV4()
	let hasConnectedExtensionPort = false

	type BridgeRequestCandidate = {
		readonly type?: unknown
		readonly bridgeCapability?: unknown
		readonly method?: unknown
		readonly params?: unknown
		readonly usingInterceptorWithoutSigner?: unknown
		readonly requestId?: unknown
		readonly internal?: unknown
		readonly replayOnDisconnect?: unknown
	}

	const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
	const isForwardedDiagnosticsRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
	const isBridgeRequestCandidate = (value: unknown): value is BridgeRequestCandidate => typeof value === 'object' && value !== null
	const isBridgeRequest = (value: unknown, expectedBridgeCapability: string): value is {
		readonly type: typeof INTERCEPTOR_BRIDGE_REQUEST_MESSAGE
		readonly bridgeCapability: string
		readonly method: string
		readonly params?: readonly unknown[]
		readonly usingInterceptorWithoutSigner: boolean
		readonly requestId: number
		readonly internal?: true
		readonly replayOnDisconnect?: true
	} => {
		if (!isBridgeRequestCandidate(value)) return false
		if (value.type !== INTERCEPTOR_BRIDGE_REQUEST_MESSAGE) return false
		if (value.bridgeCapability !== expectedBridgeCapability) return false
		if (typeof value.method !== 'string') return false
		if (value.params !== undefined && !Array.isArray(value.params)) return false
		if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return false
		if (typeof value.requestId !== 'number') return false
		if (value.internal !== undefined && value.internal !== true) return false
		if (value.replayOnDisconnect !== undefined && value.replayOnDisconnect !== true) return false
		return true
	}
	type ForwardedBridgeMessage = {
		readonly replayOnDisconnect: boolean
		readonly data: {
			readonly interceptorRequest: true
			readonly method: string
			readonly params?: readonly unknown[]
			readonly usingInterceptorWithoutSigner: boolean
			readonly requestId: number
			readonly interceptorInternalRequest?: true
		}
	}
	const stringifyForwardedThrownValue = (value: unknown) => {
		if (value instanceof Error) return value.stack ?? `${ value.name }: ${ value.message }`
		if (typeof value === 'bigint') return value.toString()
		try {
			const stringified = JSON.stringify(value, (_key: string, nestedValue: unknown) => typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue)
			if (stringified !== undefined) return stringified
		} catch (error: unknown) {
			const fallbackValue = stringifyForwardedFallbackValue(value)
			return `${ fallbackValue }\n\n[serialization fallback: ${ stringifyForwardedFallbackError(error) }]`
		}
		return stringifyForwardedFallbackValue(value)
	}
	const getForwardedDiagnosticsSummary = (error: unknown) => {
		if (error instanceof Error) return error.message
		if (typeof error === 'string') return error
		if (error === undefined) return 'Unexpected thrown value: undefined'
		if (error === null) return 'Unexpected thrown value: null'
		if (isForwardedDiagnosticsRecord(error)) {
			const { message } = error
			if (typeof message === 'string') return message
		}
		return String(error)
	}
	const getForwardedDiagnosticsRequestContext = (value: unknown): ForwardedDiagnosticsRequestContext => {
		if (!isForwardedDiagnosticsRecord(value)) return {}
		const { requestId, method } = value
		return {
			...(typeof requestId === 'number' ? { requestId } : {}),
			...(typeof method === 'string' ? { requestMethod: method } : {}),
		}
	}
	const formatForwardedDiagnostics = (source: 'inpage' | 'content-script' | 'document-start', phase: string, summary: string, thrown: unknown, context: ForwardedDiagnosticsRequestContext = {}): string => {
		return [
			`${ source }: ${ summary }`,
			`phase: ${ phase }`,
			...(context.requestMethod !== undefined ? [`requestMethod: ${ context.requestMethod }`] : []),
			...(context.requestId !== undefined ? [`requestId: ${ context.requestId }`] : []),
			`thrown:\n${ stringifyForwardedThrownValue(thrown) }`,
		].join('\n\n')
	}
	const serializeForwardedDiagnostics = (source: 'inpage' | 'content-script' | 'document-start', phase: string, error: unknown, context: ForwardedDiagnosticsRequestContext = {}): string => formatForwardedDiagnostics(source, phase, getForwardedDiagnosticsSummary(error), error, context)
	const createForwardedDiagnosticsFromRaw = (source: 'inpage' | 'content-script' | 'document-start', phase: string, message: string, raw: unknown, context: ForwardedDiagnosticsRequestContext = {}): string => formatForwardedDiagnostics(source, phase, message, raw, context)
	const isIgnorableContentScriptPortError = (error: Error) => error.message.includes('Attempting to use a disconnected port object')
		|| error.message.includes('Could not establish connection. Receiving end does not exist')
		|| error.message.includes('Extension context invalidated')
	const isMissingContentScriptPortReceiverError = (error: Error) => error.message.includes('Could not establish connection. Receiving end does not exist')
	const isTerminalContentScriptPortError = (error: Error) => error.message.includes('Extension context invalidated')
	const pendingBridgeMessages: ForwardedBridgeMessage[] = []
	// Replay and settlement are transport metadata supplied by the inpage and background layers; this proxy does not infer RPC semantics.
	const unsettledReplayableRequests = new Map<number, ForwardedBridgeMessage>()
	const getSettledBridgeRequestId = (message: unknown) => {
		if (typeof message !== 'object' || message === null) return undefined
		if (!('requestId' in message) || typeof message.requestId !== 'number') return undefined
		if (!('bridgeRequestSettled' in message) || message.bridgeRequestSettled !== true) return undefined
		return message.requestId
	}
	const withoutBridgeSettlementMarker = (message: unknown) => {
		if (typeof message !== 'object' || message === null || !('bridgeRequestSettled' in message)) return message
		const { bridgeRequestSettled: _bridgeRequestSettled, ...messageWithoutSettlementMarker } = message
		return messageWithoutSettlementMarker
	}
	let inFlightBridgeMessage: ForwardedBridgeMessage | undefined
	const settleReplayableRequest = (requestId: number) => {
		const settledRequest = unsettledReplayableRequests.get(requestId)
		if (settledRequest === undefined) return
		unsettledReplayableRequests.delete(requestId)
		const queuedRequestIndex = pendingBridgeMessages.indexOf(settledRequest)
		if (queuedRequestIndex === -1) return
		const settledRequestWasInFlight = pendingBridgeMessages[queuedRequestIndex] === inFlightBridgeMessage
		pendingBridgeMessages.splice(queuedRequestIndex, 1)
		if (!settledRequestWasInFlight) return
		inFlightBridgeMessage = undefined
		if (extensionPort !== undefined) flushPendingBridgeMessages(extensionPort)
	}
	const queueUnsettledReplayableRequests = () => {
		const queuedRequestIds = new Set(pendingBridgeMessages.map((message) => message.data.requestId))
		for (const [requestId, message] of unsettledReplayableRequests) {
			if (queuedRequestIds.has(requestId)) continue
			pendingBridgeMessages.push(message)
		}
		pendingBridgeMessages.sort((first, second) => first.data.requestId - second.data.requestId)
	}
	const markExtensionPortDisconnected = (port: browser.runtime.Port) => {
		if (extensionPort !== port) return
		extensionPort = undefined
		inFlightBridgeMessage = undefined
		queueUnsettledReplayableRequests()
		pageHidden = true
	}
	let connect: () => browser.runtime.Port
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	const scheduleReconnect = () => {
		if (reconnectTimer !== undefined) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined
			if (extensionPort !== undefined) return
			try {
				connect()
			} catch (reconnectError: unknown) {
				if (reconnectError instanceof Error && isIgnorableContentScriptPortError(reconnectError)) {
					if (!isTerminalContentScriptPortError(reconnectError)) scheduleReconnect()
					return
				}
				throw reconnectError
			}
		}, 250)
	}
	const reconnectAfterPortFailure = (port: browser.runtime.Port, error: Error | undefined) => {
		if (extensionPort !== port) return extensionPort
		markExtensionPortDisconnected(port)
		if (error !== undefined && isTerminalContentScriptPortError(error)) return undefined
		if (error !== undefined && isMissingContentScriptPortReceiverError(error)) {
			scheduleReconnect()
			return undefined
		}
		try {
			return connect()
		} catch (reconnectError: unknown) {
			if (reconnectError instanceof Error && isIgnorableContentScriptPortError(reconnectError)) {
				if (!isTerminalContentScriptPortError(reconnectError)) scheduleReconnect()
				return undefined
			}
			throw reconnectError
		}
	}
	const flushPendingBridgeMessages = (port: browser.runtime.Port) => {
		while (extensionPort === port) {
			if (inFlightBridgeMessage !== undefined) return
			const message = pendingBridgeMessages[0]
			if (message === undefined) return
			inFlightBridgeMessage = message
			try {
				port.postMessage({ data: message.data })
				checkAndThrowRuntimeLastError()
				return
			} catch (error: unknown) {
				if (error instanceof Error && isIgnorableContentScriptPortError(error)) {
					reconnectAfterPortFailure(port, error)
					return
				}
				if (error instanceof Error && error.message.includes('User denied')) {
					const discardedMessage = pendingBridgeMessages.shift()
					if (discardedMessage !== undefined) unsettledReplayableRequests.delete(discardedMessage.data.requestId)
					inFlightBridgeMessage = undefined
					continue
				}
				throw error
			}
		}
	}
	const reportInterceptorError = (diagnostics: string) => {
		const currentExtensionPort = extensionPort
		if (currentExtensionPort === undefined) return
		try {
			currentExtensionPort.postMessage({ data: { interceptorRequest: true, interceptorInternalRequest: true, usingInterceptorWithoutSigner: false, requestId: -1, method: 'InterceptorError', params: [diagnostics] } })
		} catch(reportingError: unknown) {
			if (reportingError instanceof Error && isIgnorableContentScriptPortError(reportingError)) {
				reconnectAfterPortFailure(currentExtensionPort, reportingError)
				return
			}
			console.error(reportingError)
		}
	}

	const forwardInpageMessageToBackground = (data: unknown) => {
		const expectedBridgeCapability = inpageBridgeCapability
		if (expectedBridgeCapability === undefined || !isBridgeRequest(data, expectedBridgeCapability)) return
		const message: ForwardedBridgeMessage = { replayOnDisconnect: data.replayOnDisconnect === true, data: {
			interceptorRequest: true,
			method: data.method,
			...(data.params !== undefined ? { params: data.params } : {}),
			usingInterceptorWithoutSigner: data.usingInterceptorWithoutSigner,
			requestId: data.requestId,
			...(data.internal === true ? { interceptorInternalRequest: true as const } : {}),
		} }
		if (message.replayOnDisconnect) unsettledReplayableRequests.set(data.requestId, message)
		pendingBridgeMessages.push(message)
		const currentExtensionPort = extensionPort
		if (currentExtensionPort === undefined) {
			scheduleReconnect()
			return
		}
		try {
			flushPendingBridgeMessages(currentExtensionPort)
		} catch (error: unknown) {
			reportInterceptorError(serializeForwardedDiagnostics(diagnosticsSource, 'forward page message', error, getForwardedDiagnosticsRequestContext(data)))
			throw error
		}
	}

	globalThis.addEventListener('message', (messageEvent: MessageEvent<unknown>) => {
		if (
			inpagePort !== undefined
			|| (messageEvent.source !== null && messageEvent.source !== window)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('type' in messageEvent.data)
			|| messageEvent.data.type !== INTERCEPTOR_BRIDGE_PORT_MESSAGE
			|| !('bridgeCapability' in messageEvent.data)
			|| !isUuid(messageEvent.data.bridgeCapability)
		) return
		const port = messageEvent.ports[0]
		if (port === undefined) {
			reportInterceptorError(createForwardedDiagnosticsFromRaw(diagnosticsSource, 'connect inpage bridge', 'Missing inpage MessagePort', messageEvent.data, getForwardedDiagnosticsRequestContext(messageEvent.data)))
			return
		}
		// Both scripts run at document_start. The inpage side retains the opposite
		// MessagePort endpoint in a closure, so page code that observes this transferred
		// endpoint can only send toward the inpage provider, not toward the extension.
		// Pinning every request to this session capability also prevents a later page
		// message or replacement port from being treated as the established bridge.
		inpageBridgeCapability = messageEvent.data.bridgeCapability
		inpagePort = port
		inpagePort.onmessage = (portMessageEvent: MessageEvent<unknown>) => forwardInpageMessageToBackground(portMessageEvent.data)
		inpagePort.postMessage({
			type: INTERCEPTOR_BRIDGE_INITIALIZED_MESSAGE,
			bridgeCapability: inpageBridgeCapability,
			contentScriptCapability,
		})
	})

	connect = () => {
		if (reconnectTimer !== undefined) {
			clearTimeout(reconnectTimer)
			reconnectTimer = undefined
		}
		const previousExtensionPort = extensionPort
		extensionPort = undefined
		inFlightBridgeMessage = undefined
		if (previousExtensionPort !== undefined) {
			try {
				previousExtensionPort.disconnect()
			} catch (error: unknown) {
				if (!(error instanceof Error && isIgnorableContentScriptPortError(error))) throw error
			}
		}
		const connectedExtensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })
		extensionPort = connectedExtensionPort
		const reconnectingExistingBridge = hasConnectedExtensionPort
		hasConnectedExtensionPort = true

		// forward all messages we get from the background script to the window so the page script can filter and process them
		connectedExtensionPort.onMessage.addListener(messageEvent => {
			const isBridgeAcknowledgement = typeof messageEvent === 'object'
				&& messageEvent !== null
				&& 'type' in messageEvent
				&& messageEvent.type === INTERCEPTOR_BRIDGE_ACKNOWLEDGEMENT_MESSAGE
				&& 'requestId' in messageEvent
				&& typeof messageEvent.requestId === 'number'
			if (isBridgeAcknowledgement) {
				if (extensionPort !== connectedExtensionPort) return
				const acknowledgedMessage = pendingBridgeMessages[0]
				if (acknowledgedMessage?.data.requestId !== messageEvent.requestId) return
				pendingBridgeMessages.shift()
				inFlightBridgeMessage = undefined
				flushPendingBridgeMessages(connectedExtensionPort)
				return
			}
			if (typeof messageEvent !== 'object' || messageEvent === null || !('interceptorApproved' in messageEvent)) {
				console.error('Malformed message:')
				console.error(messageEvent)
				reportInterceptorError(createForwardedDiagnosticsFromRaw(diagnosticsSource, 'receive background message', 'Malformed message from background script', messageEvent, getForwardedDiagnosticsRequestContext(messageEvent)))
				return
			}
			try {
				if (inpagePort === undefined) {
					reportInterceptorError(createForwardedDiagnosticsFromRaw(diagnosticsSource, 'forward background message', 'Inpage MessagePort is not connected', messageEvent, getForwardedDiagnosticsRequestContext(messageEvent)))
					return
				}
				const backgroundMessage = withoutBridgeSettlementMarker(messageEvent)
				if (typeof backgroundMessage !== 'object' || backgroundMessage === null) throw new Error('Malformed message from background script')
				inpagePort.postMessage({ ...backgroundMessage, contentScriptCapability })
				checkAndThrowRuntimeLastError()
				const settledBridgeRequestId = getSettledBridgeRequestId(messageEvent)
				if (settledBridgeRequestId !== undefined) settleReplayableRequest(settledBridgeRequestId)
			} catch (error) {
				console.error(error)
			}
		})

		connectedExtensionPort.onDisconnect.addListener(() => {
			if (extensionPort !== connectedExtensionPort) return
			const lastError = browser.runtime.lastError
			const disconnectError = lastError?.message === undefined ? undefined : new Error(lastError.message)
			reconnectAfterPortFailure(connectedExtensionPort, disconnectError)
		})
		flushPendingBridgeMessages(connectedExtensionPort)
		if (reconnectingExistingBridge && inpagePort !== undefined && inpageBridgeCapability !== undefined) {
			inpagePort.postMessage({
				type: INTERCEPTOR_BRIDGE_RECONNECTED_MESSAGE,
				bridgeCapability: inpageBridgeCapability,
				contentScriptCapability,
			})
		}
		return connectedExtensionPort
	}
	connect()
	browser.runtime.onMessage.addListener(async (message: unknown) => {
		if (
			typeof message !== 'object'
			|| message === null
			|| !('method' in message)
			|| message.method !== 'interceptor_reconnect_content_script_port'
			|| !('connectionName' in message)
			|| typeof message.connectionName !== 'string'
		) return undefined
		try {
			if (BigInt(message.connectionName) !== BigInt(connectionNameNotUndefined)) return undefined
			connect()
			return { reconnected: true }
		} catch (error: unknown) {
			if (error instanceof Error && isIgnorableContentScriptPortError(error)) {
				if (!isTerminalContentScriptPortError(error)) scheduleReconnect()
				return { reconnected: false }
			}
			throw error
		}
	})

	// https://web.dev/articles/bfcache
	const bfCachePageShow = () => {
		try {
			checkAndThrowRuntimeLastError()
			if (pageHidden) connect()
			checkAndThrowRuntimeLastError()
			pageHidden = false
		} catch (error: unknown) {
			console.error(error)
		}
	}
	globalThis.addEventListener('pageshow', () => bfCachePageShow(), false)
	globalThis.addEventListener('pagehide', () => { pageHidden = true }, false)

	try {
		checkAndThrowRuntimeLastError()
	} catch (error: unknown) {
		console.error(error)
	}
}

function registerContentScriptListener() {
	Object.defineProperty(globalThis, contentScriptListenerGlobalKey, { configurable: true, value: listenContentScript })
}

registerContentScriptListener()

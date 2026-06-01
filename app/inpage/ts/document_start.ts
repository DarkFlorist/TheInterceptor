function injectScript(_content: string) {
	if (
		(globalThis as unknown as { interceptorInjected: true | undefined })
			.interceptorInjected
	)
		return
	;(
		globalThis as unknown as { interceptorInjected?: boolean }
	).interceptorInjected = true

	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null =
			browser.runtime.lastError // firefox return `null` on no errors
		if (error !== null && error !== undefined && error.message !== undefined)
			throw new Error(error.message)
	}

	function listenContentScript(connectionName: string | undefined) {
		const INTERCEPTOR_BRIDGE_PORT_MESSAGE = 'interceptor_bridge_port'
		const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
		const checkAndThrowRuntimeLastError = () => {
			const error: browser.runtime._LastError | undefined | null =
				browser.runtime.lastError // firefox return `null` on no errors
			if (error !== null && error !== undefined && error.message !== undefined)
				throw new Error(error.message)
		}
		type ForwardedDiagnosticsRequestContext = {
			readonly requestId?: number
			readonly requestMethod?: string
		}
		const stringifyForwardedFallbackError = (error: unknown) =>
			error instanceof Error
				? `${error.name}: ${error.message}`
				: `Unexpected thrown value: ${String(error)}`
		const stringifyForwardedFallbackValue = (value: unknown) => {
			try {
				return String(value)
			} catch (error: unknown) {
				return `[failed to stringify value: ${stringifyForwardedFallbackError(error)}]`
			}
		}

		/**
		 * this script executed within the context of the active tab when the user clicks the extension bar button
		 * this script serves as a _very thin_ proxy between the page scripts (dapp) and the extension, simply forwarding messages between the two
		 */
		// the content script is a very thin proxy between the background script and the page script

		const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

		function generateId(len: number) {
			const arr = new Uint8Array((len || 40) / 2)
			globalThis.crypto.getRandomValues(arr)
			return `0x${Array.from(arr, dec2hex).join('')}`
		}
		const connectionNameNotUndefined =
			connectionName === undefined ? generateId(40) : connectionName
		let pageHidden = false
		let extensionPort: browser.runtime.Port | undefined
		let inpagePort: MessagePort | undefined

		type BridgeRequestCandidate = {
			readonly type?: unknown
			readonly method?: unknown
			readonly params?: unknown
			readonly usingInterceptorWithoutSigner?: unknown
			readonly requestId?: unknown
			readonly internal?: unknown
		}

		const isForwardedDiagnosticsRecord = (
			value: unknown,
		): value is Record<string, unknown> =>
			typeof value === 'object' && value !== null
		const isBridgeRequestCandidate = (
			value: unknown,
		): value is BridgeRequestCandidate =>
			typeof value === 'object' && value !== null
		const isBridgeRequest = (
			value: unknown,
		): value is {
			readonly type: typeof INTERCEPTOR_BRIDGE_REQUEST_MESSAGE
			readonly method: string
			readonly params?: readonly unknown[]
			readonly usingInterceptorWithoutSigner: boolean
			readonly requestId: number
			readonly internal?: true
		} => {
			if (!isBridgeRequestCandidate(value)) return false
			if (value.type !== INTERCEPTOR_BRIDGE_REQUEST_MESSAGE) return false
			if (typeof value.method !== 'string') return false
			if (value.params !== undefined && !Array.isArray(value.params))
				return false
			if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return false
			if (typeof value.requestId !== 'number') return false
			if (value.internal !== undefined && value.internal !== true) return false
			return true
		}
		const stringifyForwardedThrownValue = (value: unknown) => {
			if (value instanceof Error)
				return value.stack ?? `${value.name}: ${value.message}`
			if (typeof value === 'bigint') return value.toString()
			try {
				const stringified = JSON.stringify(
					value,
					(_key: string, nestedValue: unknown) =>
						typeof nestedValue === 'bigint'
							? nestedValue.toString()
							: nestedValue,
				)
				if (stringified !== undefined) return stringified
			} catch (error: unknown) {
				const fallbackValue = stringifyForwardedFallbackValue(value)
				return `${fallbackValue}\n\n[serialization fallback: ${stringifyForwardedFallbackError(error)}]`
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
		const getForwardedDiagnosticsRequestContext = (
			value: unknown,
		): ForwardedDiagnosticsRequestContext => {
			if (!isForwardedDiagnosticsRecord(value)) return {}
			const { requestId, method } = value
			return {
				...(typeof requestId === 'number' ? { requestId } : {}),
				...(typeof method === 'string' ? { requestMethod: method } : {}),
			}
		}
		const formatForwardedDiagnostics = (
			source: 'inpage' | 'content-script' | 'document-start',
			phase: string,
			summary: string,
			thrown: unknown,
			context: ForwardedDiagnosticsRequestContext = {},
		): string => {
			return [
				`${source}: ${summary}`,
				`phase: ${phase}`,
				...(context.requestMethod !== undefined
					? [`requestMethod: ${context.requestMethod}`]
					: []),
				...(context.requestId !== undefined
					? [`requestId: ${context.requestId}`]
					: []),
				`thrown:\n${stringifyForwardedThrownValue(thrown)}`,
			].join('\n\n')
		}
		const serializeForwardedDiagnostics = (
			source: 'inpage' | 'content-script' | 'document-start',
			phase: string,
			error: unknown,
			context: ForwardedDiagnosticsRequestContext = {},
		): string =>
			formatForwardedDiagnostics(
				source,
				phase,
				getForwardedDiagnosticsSummary(error),
				error,
				context,
			)
		const createForwardedDiagnosticsFromRaw = (
			source: 'inpage' | 'content-script' | 'document-start',
			phase: string,
			message: string,
			raw: unknown,
			context: ForwardedDiagnosticsRequestContext = {},
		): string =>
			formatForwardedDiagnostics(source, phase, message, raw, context)
		const reportInterceptorError = (diagnostics: string) => {
			if (extensionPort === undefined) return
			try {
				extensionPort.postMessage({
					data: {
						interceptorRequest: true,
						interceptorInternalRequest: true,
						usingInterceptorWithoutSigner: false,
						requestId: -1,
						method: 'InterceptorError',
						params: [diagnostics],
					},
				})
			} catch (reportingError: unknown) {
				console.error(reportingError)
			}
		}

		const forwardInpageMessageToBackground = (data: unknown) => {
			if (extensionPort === undefined) return
			if (!isBridgeRequest(data)) return
			try {
				extensionPort.postMessage({
					data: {
						interceptorRequest: true,
						method: data.method,
						...(data.params !== undefined ? { params: data.params } : {}),
						usingInterceptorWithoutSigner: data.usingInterceptorWithoutSigner,
						requestId: data.requestId,
						...(data.internal === true
							? { interceptorInternalRequest: true as const }
							: {}),
					},
				})
				checkAndThrowRuntimeLastError()
			} catch (error) {
				if (error instanceof Error) {
					if (error.message?.includes('Extension context invalidated.')) {
						// this error happens when the extension is refreshed and the page cannot reach The Interceptor anymore
						return
					}
					if (error.message?.includes('User denied')) return // user denied signature
				}
				reportInterceptorError(
					serializeForwardedDiagnostics(
						'document-start',
						'forward page message',
						error,
						getForwardedDiagnosticsRequestContext(data),
					),
				)
				throw error
			}
		}

		globalThis.addEventListener(
			'message',
			(messageEvent: MessageEvent<unknown>) => {
				if (
					inpagePort !== undefined ||
					typeof messageEvent.data !== 'object' ||
					messageEvent.data === null ||
					!('type' in messageEvent.data) ||
					messageEvent.data.type !== INTERCEPTOR_BRIDGE_PORT_MESSAGE
				)
					return
				const port = messageEvent.ports[0]
				if (port === undefined) {
					reportInterceptorError(
						createForwardedDiagnosticsFromRaw(
							'document-start',
							'connect inpage bridge',
							'Missing inpage MessagePort',
							messageEvent.data,
							getForwardedDiagnosticsRequestContext(messageEvent.data),
						),
					)
					return
				}
				inpagePort = port
				inpagePort.onmessage = (portMessageEvent: MessageEvent<unknown>) =>
					forwardInpageMessageToBackground(portMessageEvent.data)
			},
		)

		const connect = () => {
			if (extensionPort) extensionPort.disconnect()
			extensionPort = browser.runtime.connect({
				name: connectionNameNotUndefined,
			})

			// forward all messages we get from the background script to the window so the page script can filter and process them
			extensionPort.onMessage.addListener((messageEvent) => {
				if (
					typeof messageEvent !== 'object' ||
					messageEvent === null ||
					!('interceptorApproved' in messageEvent)
				) {
					console.error('Malformed message:')
					console.error(messageEvent)
					reportInterceptorError(
						createForwardedDiagnosticsFromRaw(
							'document-start',
							'receive background message',
							'Malformed message from background script',
							messageEvent,
							getForwardedDiagnosticsRequestContext(messageEvent),
						),
					)
					return
				}
				try {
					if (inpagePort === undefined) {
						reportInterceptorError(
							createForwardedDiagnosticsFromRaw(
								'document-start',
								'forward background message',
								'Inpage MessagePort is not connected',
								messageEvent,
								getForwardedDiagnosticsRequestContext(messageEvent),
							),
						)
						return
					}
					inpagePort.postMessage(messageEvent)
					checkAndThrowRuntimeLastError()
				} catch (error) {
					console.error(error)
				}
			})

			extensionPort.onDisconnect.addListener(() => {
				pageHidden = true
			})
		}
		connect()

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
		globalThis.addEventListener(
			'pagehide',
			() => {
				pageHidden = true
			},
			false,
		)

		try {
			checkAndThrowRuntimeLastError()
		} catch (error: unknown) {
			console.error(error)
		}
	}

	try {
		listenContentScript(undefined)
		const container = document.head || document.documentElement
		const scriptTag = document.createElement('script')
		scriptTag.setAttribute('async', 'false')
		if (_content === '[[injected.ts]]')
			scriptTag.src = browser.runtime.getURL('inpage/js/inpage.js')
		else scriptTag.textContent = _content
		container.insertBefore(scriptTag, container.children[1])
		container.removeChild(scriptTag)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
	}
}

injectScript('[[injected.ts]]')

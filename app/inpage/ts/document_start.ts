function injectScript(_content: string) {
	if ((globalThis as unknown as { interceptorInjected: true | undefined }).interceptorInjected) return
	;(globalThis as unknown as { interceptorInjected?: boolean }).interceptorInjected = true

	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
	}

	function listenContentScript(connectionName: string | undefined) {
		const checkAndThrowRuntimeLastError = () => {
			const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
			if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
		}
		type ForwardedErrorSource = 'inpage' | 'content-script' | 'document-start'
		type ForwardedDiagnostics = {
			readonly source: ForwardedErrorSource
			readonly phase: string
			readonly message: string
			readonly name?: string
			readonly stack?: string
			readonly code?: number
			readonly data?: string
			readonly cause?: string
			readonly requestId?: number
			readonly requestMethod?: string
			readonly raw?: string
		}
		type ForwardedDiagnosticsRequestContext = {
			readonly requestId?: number
			readonly requestMethod?: string
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
		const connectionNameNotUndefined = connectionName === undefined ? generateId(40) : connectionName
		let pageHidden = false
		let extensionPort: browser.runtime.Port | undefined = undefined
		const FORWARDED_DIAGNOSTICS_MAX_LENGTH = 4000

		const truncateForwardedDiagnosticsString = (value: string) => {
			if (value.length <= FORWARDED_DIAGNOSTICS_MAX_LENGTH) return value
			return `${ value.slice(0, FORWARDED_DIAGNOSTICS_MAX_LENGTH - 1) }…`
		}

		const isForwardedDiagnosticsRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
		const getForwardedDiagnosticsStringProperty = (value: Record<string, unknown>, key: string) => {
			const property = value[key]
			return typeof property === 'string' ? property : undefined
		}
		const getForwardedDiagnosticsNumberProperty = (value: Record<string, unknown>, key: string) => {
			const property = value[key]
			return typeof property === 'number' ? property : undefined
		}
		const createForwardedDiagnosticsCircularReplacer = () => {
			const seen = new WeakSet<object>()
			return (_key: string, value: unknown) => {
				if (typeof value === 'bigint') return value.toString()
				if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value)) return '[Circular]'
					seen.add(value)
				}
				return value
			}
		}
		const stringifyForwardedDiagnosticsValue = (value: unknown) => {
			if (typeof value === 'string') return truncateForwardedDiagnosticsString(value)
			try {
				const stringified = JSON.stringify(value, createForwardedDiagnosticsCircularReplacer())
				if (stringified !== undefined) return truncateForwardedDiagnosticsString(stringified)
			} catch (_error) {}
			return truncateForwardedDiagnosticsString(String(value))
		}
		const getForwardedDiagnosticsRequestContext = (value: unknown): ForwardedDiagnosticsRequestContext => {
			if (!isForwardedDiagnosticsRecord(value)) return {}
			return {
				...(typeof value['requestId'] === 'number' ? { requestId: value['requestId'] } : {}),
				...(typeof value['method'] === 'string' ? { requestMethod: value['method'] } : {}),
			}
		}
		const serializeForwardedDiagnostics = (source: ForwardedErrorSource, phase: string, error: unknown, context: ForwardedDiagnosticsRequestContext = {}): ForwardedDiagnostics => {
			const errorRecord = isForwardedDiagnosticsRecord(error) ? error : undefined
			const fallbackMessage = error === undefined ? 'Unexpected thrown value: undefined' : error === null ? 'Unexpected thrown value: null' : typeof error === 'string' ? error : 'Unexpected thrown value.'
			const messageProperty = errorRecord === undefined ? undefined : getForwardedDiagnosticsStringProperty(errorRecord, 'message')
			const nameProperty = errorRecord === undefined ? undefined : getForwardedDiagnosticsStringProperty(errorRecord, 'name')
			const stackProperty = errorRecord === undefined ? undefined : getForwardedDiagnosticsStringProperty(errorRecord, 'stack')
			const code = errorRecord === undefined ? undefined : getForwardedDiagnosticsNumberProperty(errorRecord, 'code')
			const message = error instanceof Error ? error.message : messageProperty ?? fallbackMessage
			const name = error instanceof Error ? error.name : nameProperty
			const stack = error instanceof Error ? error.stack : stackProperty
			return {
				source,
				phase,
				message: truncateForwardedDiagnosticsString(message),
				...(name !== undefined ? { name: truncateForwardedDiagnosticsString(name) } : {}),
				...(stack !== undefined ? { stack: truncateForwardedDiagnosticsString(stack) } : {}),
				...(code !== undefined ? { code } : {}),
				...(errorRecord !== undefined && 'data' in errorRecord ? { data: stringifyForwardedDiagnosticsValue(errorRecord['data']) } : {}),
				...(errorRecord !== undefined && 'cause' in errorRecord ? { cause: stringifyForwardedDiagnosticsValue(errorRecord['cause']) } : {}),
				...(error instanceof Error ? {} : { raw: stringifyForwardedDiagnosticsValue(error) }),
				...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
				...(context.requestMethod !== undefined ? { requestMethod: context.requestMethod } : {}),
			}
		}
		const createForwardedDiagnosticsFromRaw = (source: ForwardedErrorSource, phase: string, message: string, raw: unknown, context: ForwardedDiagnosticsRequestContext = {}): ForwardedDiagnostics => ({
			source,
			phase,
			message,
			raw: stringifyForwardedDiagnosticsValue(raw),
			...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
			...(context.requestMethod !== undefined ? { requestMethod: context.requestMethod } : {}),
		})
		const reportInterceptorError = (diagnostics: ForwardedDiagnostics) => {
			if (extensionPort === undefined) return
			try {
				extensionPort.postMessage({ data: { interceptorRequest: true, usingInterceptorWithoutSigner: false, requestId: -1, method: 'InterceptorError', params: [diagnostics] } })
			} catch(reportingError: unknown) {
				console.error(reportingError)
			}
		}

		// forward all message events to the background script, which will then filter and process them
		// biome-ignore lint/suspicious/noExplicitAny: MessageEvent default signature
		globalThis.addEventListener('message', (messageEvent: MessageEvent<any>) => {
			if (extensionPort === undefined) return
			if (
				typeof messageEvent !== 'object'
				|| messageEvent === null
				|| !('data' in messageEvent)
				|| typeof messageEvent.data !== 'object'
				|| messageEvent.data === null
				|| !('interceptorRequest' in messageEvent.data)
			) return
			try {
				// we only want the data element, if it exists, and postMessage will fail if it can't clone the object fully (and it cannot clone a MessageEvent)
				if (!('data' in messageEvent) || !(typeof messageEvent.data === 'object' && messageEvent.data !== null) || !('interceptorRequest' in messageEvent.data)) return
				extensionPort.postMessage({ data: messageEvent.data })
				checkAndThrowRuntimeLastError()
			} catch (error) {
				if (error instanceof Error) {
					if (error.message?.includes('Extension context invalidated.')) {
						// this error happens when the extension is refreshed and the page cannot reach The Interceptor anymore
						return
					}
					if (error.message?.includes('User denied')) return // user denied signature
				}
				reportInterceptorError(serializeForwardedDiagnostics('document-start', 'forward page message', error, getForwardedDiagnosticsRequestContext(messageEvent.data)))
				throw error
			}
		})

		const connect = () => {
			if (extensionPort) extensionPort.disconnect()
			extensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })

			// forward all messages we get from the background script to the window so the page script can filter and process them
			extensionPort.onMessage.addListener(messageEvent => {
				if (typeof messageEvent !== 'object' || messageEvent === null || !('interceptorApproved' in messageEvent)) {
					console.error('Malformed message:')
					console.error(messageEvent)
					reportInterceptorError(createForwardedDiagnosticsFromRaw('document-start', 'receive background message', 'Malformed message from background script', messageEvent, getForwardedDiagnosticsRequestContext(messageEvent)))
					return
				}
				try {
					globalThis.postMessage(messageEvent, '*')
					checkAndThrowRuntimeLastError()
				} catch (error) {
					console.error(error)
				}
			})

			extensionPort.onDisconnect.addListener(() => { pageHidden = true })
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
		globalThis.addEventListener('pagehide', () => { pageHidden = true }, false)

		try {
			checkAndThrowRuntimeLastError()
		} catch (error: unknown) {
			console.error(error)
		}
	}

	try {
		const container = document.head || document.documentElement
		const scriptTag = document.createElement('script')
		scriptTag.setAttribute('async', 'false')
		scriptTag.src = browser.runtime.getURL('inpage/js/inpage.js')
		container.insertBefore(scriptTag, container.children[1])
		container.removeChild(scriptTag)
		listenContentScript(undefined)
		checkAndThrowRuntimeLastError()
	} catch (error) {
	  	console.error('Interceptor: Provider injection failed.', error)
	}
}

// biome-ignore lint/style/noUnusedTemplateLiteral: Required for script injection
injectScript(`[[injected.ts]]`)

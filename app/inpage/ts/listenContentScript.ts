function listenContentScript(connectionName: string | undefined) {
	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
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

	const isForwardedDiagnosticsRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
	const stringifyForwardedThrownValue = (value: unknown) => {
		if (value instanceof Error) return value.stack ?? `${ value.name }: ${ value.message }`
		if (typeof value === 'bigint') return value.toString()
		try {
			const stringified = JSON.stringify(value, (_key: string, nestedValue: unknown) => typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue)
			if (stringified !== undefined) return stringified
		} catch (_error) {}
		return String(value)
	}
	const getForwardedDiagnosticsSummary = (error: unknown) => {
		if (error instanceof Error) return error.message
		if (typeof error === 'string') return error
		if (error === undefined) return 'Unexpected thrown value: undefined'
		if (error === null) return 'Unexpected thrown value: null'
		if (isForwardedDiagnosticsRecord(error) && typeof error['message'] === 'string') return error['message']
		return String(error)
	}
	const getForwardedDiagnosticsRequestContext = (value: unknown): ForwardedDiagnosticsRequestContext => {
		if (!isForwardedDiagnosticsRecord(value)) return {}
		return {
			...(typeof value['requestId'] === 'number' ? { requestId: value['requestId'] } : {}),
			...(typeof value['method'] === 'string' ? { requestMethod: value['method'] } : {}),
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
	const reportInterceptorError = (diagnostics: string) => {
		if (extensionPort === undefined) return
		try {
			extensionPort.postMessage({ data: { interceptorRequest: true, usingInterceptorWithoutSigner: false, requestId: -1, method: 'InterceptorError', params: [diagnostics] } })
		} catch(reportingError: unknown) {
			console.error(reportingError)
		}
	}

	// forward all page messages to the background script, which will then filter and process them
	// anything reaching this boundary is untrusted page input unless the extension proves otherwise
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
			reportInterceptorError(serializeForwardedDiagnostics('content-script', 'forward page message', error, getForwardedDiagnosticsRequestContext(messageEvent.data)))
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
				reportInterceptorError(createForwardedDiagnosticsFromRaw('content-script', 'receive background message', 'Malformed message from background script', messageEvent, getForwardedDiagnosticsRequestContext(messageEvent)))
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
listenContentScript(undefined)

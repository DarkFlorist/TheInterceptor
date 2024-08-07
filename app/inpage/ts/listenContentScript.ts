function listenContentScript(connectionName: string | undefined) {
	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox return `null` on no errors
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
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

	// forward all message events to the background script, which will then filter and process them
	// biome-ignore lint/suspicious/noExplicitAny: MessageEvent default signature
	globalThis.addEventListener('message', (messageEvent: MessageEvent<any>) => {
		if (extensionPort === undefined) return
		try {
			// we only want the data element, if it exists, and postMessage will fail if it can't clone the object fully (and it cannot clone a MessageEvent)
			if (!('data' in messageEvent)) return
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
			extensionPort.postMessage({ data: { interceptorRequest: true, usingInterceptorWithoutSigner: false, requestId: -1, method: 'InterceptorError', params: [error] } })
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
				if (extensionPort === undefined) return
				extensionPort.postMessage({ data: { interceptorRequest: true, usingInterceptorWithoutSigner: false, requestId: -1, method: 'InterceptorError', params: [messageEvent] } })
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

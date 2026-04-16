type ListenPageRequestPayload = {
	method: string
	params?: readonly unknown[]
	usingInterceptorWithoutSigner: boolean
	interceptorRequest: true
}

type ListenPageRequestEnvelope = {
	kind: 'request'
	id: number
	action: 'rpc.request'
	payload: ListenPageRequestPayload
}

type ListenPageIncomingEnvelope = {
	kind: 'response'
	id: number
	action: 'rpc.response'
	ok: true
	payload: { interceptorApproved: true }
} | {
	kind: 'response'
	id: number
	action: 'rpc.response'
	ok: false
	error: { message: string }
} | {
	kind: 'event'
	action: 'rpc.event'
	payload: { interceptorApproved: true }
}

function isListenObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function isListenRawInterceptedRequest(value: unknown): value is {
	requestId: number
	method: string
	params?: readonly unknown[]
	interceptorRequest: true
	usingInterceptorWithoutSigner: boolean
} {
	if (!isListenObject(value)) return false
	if (value.interceptorRequest !== true) return false
	if (typeof value.requestId !== 'number') return false
	if (typeof value.method !== 'string') return false
	if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return false
	if ('params' in value && value.params !== undefined && !Array.isArray(value.params)) return false
	return true
}

function createListenPageRequestEnvelope(id: number, payload: ListenPageRequestPayload): ListenPageRequestEnvelope {
	return { kind: 'request', id, action: 'rpc.request', payload }
}

function createListenPageErrorRequestEnvelope(id: number, message: string): ListenPageRequestEnvelope {
	return createListenPageRequestEnvelope(id, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		method: 'InterceptorError',
		params: [message],
	})
}

function parseListenPageIncomingEnvelope(value: unknown): ListenPageIncomingEnvelope | undefined {
	if (!isListenObject(value) || typeof value.kind !== 'string' || typeof value.action !== 'string') return undefined
	if (value.kind === 'event' && value.action === 'rpc.event' && isListenObject(value.payload) && value.payload.interceptorApproved === true) {
		return {
			kind: 'event',
			action: 'rpc.event',
			payload: { interceptorApproved: true },
		}
	}
	if (value.kind === 'response' && value.action === 'rpc.response' && typeof value.id === 'number') {
		if (value.ok === true && isListenObject(value.payload) && value.payload.interceptorApproved === true) {
			return {
				kind: 'response',
				id: value.id,
				action: 'rpc.response',
				ok: true,
				payload: { interceptorApproved: true },
			}
		}
		if (value.ok === false && isListenObject(value.error) && typeof value.error.message === 'string') {
			return {
				kind: 'response',
				id: value.id,
				action: 'rpc.response',
				ok: false,
				error: { message: value.error.message },
			}
		}
	}
	return undefined
}

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
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('interceptorRequest' in messageEvent.data)
		) return
		try {
			if (!isListenRawInterceptedRequest(messageEvent.data)) return
			extensionPort.postMessage(createListenPageRequestEnvelope(messageEvent.data.requestId, {
				method: messageEvent.data.method,
				...('params' in messageEvent.data ? { params: messageEvent.data.params } : {}),
				interceptorRequest: true,
				usingInterceptorWithoutSigner: messageEvent.data.usingInterceptorWithoutSigner,
			}))
			checkAndThrowRuntimeLastError()
		} catch (error) {
			if (error instanceof Error) {
				if (error.message?.includes('Extension context invalidated.')) {
					// this error happens when the extension is refreshed and the page cannot reach The Interceptor anymore
					return
				}
				if (error.message?.includes('User denied')) return // user denied signature
			}
			extensionPort.postMessage(createListenPageErrorRequestEnvelope(-1, JSON.stringify(error)))
			throw error
		}
	})

	const connect = () => {
		if (extensionPort) extensionPort.disconnect()
		extensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })

		// forward all messages we get from the background script to the window so the page script can filter and process them
		extensionPort.onMessage.addListener(messageEvent => {
			const parsedMessage = parseListenPageIncomingEnvelope(messageEvent)
			if (parsedMessage === undefined || (parsedMessage.kind === 'response' && parsedMessage.ok === false)) {
				console.error('Malformed message:')
				console.error(messageEvent)
				if (extensionPort === undefined) return
				extensionPort.postMessage(createListenPageErrorRequestEnvelope(-1, JSON.stringify(messageEvent)))
				return
			}
			try {
				globalThis.postMessage(parsedMessage.payload, '*')
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

type DocumentStartPageRequestPayload = {
	method: string
	params?: readonly unknown[]
	usingInterceptorWithoutSigner: boolean
	interceptorRequest: true
}

type DocumentStartPageRequestEnvelope = {
	kind: 'request'
	id: number
	action: 'rpc.request'
	payload: DocumentStartPageRequestPayload
}

type DocumentStartPageIncomingEnvelope = {
	kind: 'response'
	id: number
	action: 'rpc.response'
	ok: true
	payload: DocumentStartInpagePayload
} | {
	kind: 'response'
	id: number
	action: 'rpc.response'
	ok: false
	error: { message: string }
} | {
	kind: 'event'
	action: 'rpc.event'
	payload: DocumentStartInpagePayload
}

type DocumentStartInpagePayload = {
	interceptorApproved: true
	[key: string]: unknown
}

function isDocumentStartObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function isDocumentStartInpagePayload(value: unknown): value is DocumentStartInpagePayload {
	return isDocumentStartObject(value) && value.interceptorApproved === true
}

function isDocumentStartRawInterceptedRequest(value: unknown): value is {
	requestId: number
	method: string
	params?: readonly unknown[]
	interceptorRequest: true
	usingInterceptorWithoutSigner: boolean
} {
	if (!isDocumentStartObject(value)) return false
	if (value.interceptorRequest !== true) return false
	if (typeof value.requestId !== 'number') return false
	if (typeof value.method !== 'string') return false
	if (typeof value.usingInterceptorWithoutSigner !== 'boolean') return false
	if ('params' in value && value.params !== undefined && !Array.isArray(value.params)) return false
	return true
}

function createDocumentStartPageRequestEnvelope(id: number, payload: DocumentStartPageRequestPayload): DocumentStartPageRequestEnvelope {
	return { kind: 'request', id, action: 'rpc.request', payload }
}

function createDocumentStartPageErrorRequestEnvelope(id: number, message: string): DocumentStartPageRequestEnvelope {
	return createDocumentStartPageRequestEnvelope(id, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		method: 'InterceptorError',
		params: [message],
	})
}

function parseDocumentStartPageIncomingEnvelope(value: unknown): DocumentStartPageIncomingEnvelope | undefined {
	if (!isDocumentStartObject(value) || typeof value.kind !== 'string' || typeof value.action !== 'string') return undefined
	if (value.kind === 'event' && value.action === 'rpc.event' && isDocumentStartInpagePayload(value.payload)) {
		return {
			kind: 'event',
			action: 'rpc.event',
			payload: value.payload,
		}
	}
	if (value.kind === 'response' && value.action === 'rpc.response' && typeof value.id === 'number') {
		if (value.ok === true && isDocumentStartInpagePayload(value.payload)) {
			return {
				kind: 'response',
				id: value.id,
				action: 'rpc.response',
				ok: true,
				payload: value.payload,
			}
		}
		if (value.ok === false && isDocumentStartObject(value.error) && typeof value.error.message === 'string') {
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
				if (!isDocumentStartRawInterceptedRequest(messageEvent.data)) return
				extensionPort.postMessage(createDocumentStartPageRequestEnvelope(messageEvent.data.requestId, {
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
				extensionPort.postMessage(createDocumentStartPageErrorRequestEnvelope(-1, JSON.stringify(error)))
				throw error
			}
		})

		const connect = () => {
			if (extensionPort) extensionPort.disconnect()
			extensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })

			// forward all messages we get from the background script to the window so the page script can filter and process them
			extensionPort.onMessage.addListener(messageEvent => {
				const parsedMessage = parseDocumentStartPageIncomingEnvelope(messageEvent)
				if (parsedMessage === undefined || (parsedMessage.kind === 'response' && parsedMessage.ok === false)) {
					console.error('Malformed message:')
					console.error(messageEvent)
					if (extensionPort === undefined) return
					extensionPort.postMessage(createDocumentStartPageErrorRequestEnvelope(-1, JSON.stringify(messageEvent)))
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

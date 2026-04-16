import { createPageErrorRequestEnvelope, createPageRequestEnvelope, parsePageToPageEnvelope } from '../../ts/messages/page.js'
import { RawInterceptedRequest } from '../../ts/utils/requests.js'

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
				const parsedMessage = RawInterceptedRequest.safeParse(messageEvent.data)
				if (!parsedMessage.success || parsedMessage.value.interceptorRequest !== true) return
				extensionPort.postMessage(createPageRequestEnvelope(parsedMessage.value.requestId, {
					method: parsedMessage.value.method,
					...('params' in parsedMessage.value ? { params: parsedMessage.value.params } : {}),
					interceptorRequest: true,
					usingInterceptorWithoutSigner: parsedMessage.value.usingInterceptorWithoutSigner,
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
				extensionPort.postMessage(createPageErrorRequestEnvelope(-1, JSON.stringify(error)))
				throw error
			}
		})

		const connect = () => {
			if (extensionPort) extensionPort.disconnect()
			extensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })

			// forward all messages we get from the background script to the window so the page script can filter and process them
			extensionPort.onMessage.addListener(messageEvent => {
				const parsedMessage = parsePageToPageEnvelope(messageEvent)
				if (parsedMessage === undefined || (parsedMessage.kind === 'response' && parsedMessage.ok === false)) {
					console.error('Malformed message:')
					console.error(messageEvent)
					if (extensionPort === undefined) return
					extensionPort.postMessage(createPageErrorRequestEnvelope(-1, JSON.stringify(messageEvent)))
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

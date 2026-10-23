import { generateBridgeSecret } from '../../ts/utils/bridgeBootstrapSecret.js'
function injectScript(_content: string) {
	if ((globalThis as unknown as { interceptorInjected: true | undefined }).interceptorInjected) return
	;(globalThis as unknown as { interceptorInjected?: boolean }).interceptorInjected = true

	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox returns `null` when there is no error
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
	}

	try {
		const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
		if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
		const bridgeSecret = generateBridgeSecret()
		const prepareBridge: unknown = contentScriptListener(undefined, 'document-start', bridgeSecret)
		if (typeof prepareBridge !== 'function') throw new Error('Missing private bridge preparation callback')
		// Firefox can defer inline execution until this isolated script returns; observe the private host before its queued handshake.
		const observer = new MutationObserver(() => { if (prepareBridge() === true) observer.disconnect() })
		observer.observe(document, { childList: true, subtree: true })
		prepareBridge()
		const container = document.head || document.documentElement
		const scriptTag = document.createElement('script')
		scriptTag.setAttribute('async', 'false')
		if (_content === '[[injected.ts]]') throw new Error('Inpage source was not bundled into document_start')
		// Keep the bootstrap key and script text out of page mutation observers, including removed-node records.
		const host = document.createElement('div')
		const root = host.attachShadow({ mode: 'closed' })
		scriptTag.textContent = _content.replace('[[interceptor-bootstrap-secret]]', bridgeSecret)
		container.insertBefore(host, container.children[1])
		root.appendChild(scriptTag)
		if (prepareBridge() === true) observer.disconnect()
		container.removeChild(host)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
	}
}

injectScript('[[injected.ts]]')

function injectPageWorldScripts() {
	if ((globalThis as unknown as { interceptorInjected: true | undefined }).interceptorInjected) return

	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox returns `null` when there is no error
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
	}

	try {
		const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
		if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
		contentScriptListener(undefined, 'document-start')
		const container = document.head || document.documentElement
		const insertAndRemoveScript = (script: HTMLScriptElement) => {
			container.insertBefore(script, container.children[1])
			container.removeChild(script)
		}
		// The build fills in this file's compatibility-mode provider, both as source and as its extension URL.
		const pageWorldProviderSource = '[[pageWorldProviderSource]]'
		const pageWorldProviderScriptPath = '[[pageWorldProviderScriptPath]]'
		// An inline script runs synchronously when inserted, so the provider exists before any later page script. The provider's first statement marks its script element, which this content script shares, so a missing mark means the page CSP blocked inline scripts.
		const providerRanAttribute = 'data-interceptor-provider-ran'
		const inlineProviderScript = document.createElement('script')
		inlineProviderScript.textContent = `document.currentScript.setAttribute('${ providerRanAttribute }', '');\n${ pageWorldProviderSource }`
		insertAndRemoveScript(inlineProviderScript)
		if (!inlineProviderScript.hasAttribute(providerRanAttribute)) {
			// Firefox exempts extension resources from the page CSP, so the provider still loads from its URL there, though asynchronously.
			const externalProviderScript = document.createElement('script')
			externalProviderScript.src = browser.runtime.getURL(pageWorldProviderScriptPath)
			insertAndRemoveScript(externalProviderScript)
		}
		;(globalThis as unknown as { interceptorInjected?: boolean }).interceptorInjected = true
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
	}
}

injectPageWorldScripts()

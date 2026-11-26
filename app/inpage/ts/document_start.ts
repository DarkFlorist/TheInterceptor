function injectPageWorldScripts() {
	if (Reflect.get(globalThis, 'interceptorInjected') === true) return

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
		Reflect.set(globalThis, 'interceptorInjected', true)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
		throw error
	}
}

injectPageWorldScripts()

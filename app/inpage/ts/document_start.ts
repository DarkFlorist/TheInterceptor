function injectPageWorldProvider() {
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
		const inlineScript = document.createElement('script')
		inlineScript.textContent = `document.currentScript.setAttribute('${ providerRanAttribute }', '');\n${ pageWorldProviderSource }`
		insertAndRemoveScript(inlineScript)
		if (!inlineScript.hasAttribute(providerRanAttribute)) {
			// A page CSP can block inline execution; load the same provider from its extension URL.
			const externalScript = document.createElement('script')
			externalScript.async = false
			externalScript.src = browser.runtime.getURL(pageWorldProviderScriptPath)
			insertAndRemoveScript(externalScript)
		}
		Reflect.set(globalThis, 'interceptorInjected', true)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
		throw error
	}
}

injectPageWorldProvider()

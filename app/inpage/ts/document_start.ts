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
		const extensions: readonly { readonly source: string, readonly scriptPath: string }[] = JSON.parse('[[pageWorldExtensionScripts]]')
		for (const script of [{ source: pageWorldProviderSource, scriptPath: pageWorldProviderScriptPath }, ...extensions]) {
			const inlineScript = document.createElement('script')
			inlineScript.textContent = `document.currentScript.setAttribute('${ providerRanAttribute }', '');\n${ script.source }`
			insertAndRemoveScript(inlineScript)
			if (!inlineScript.hasAttribute(providerRanAttribute)) {
				// Ordered external scripts preserve provider-before-extension initialization when Firefox falls back through page CSP.
				const externalScript = document.createElement('script')
				externalScript.async = false
				externalScript.src = browser.runtime.getURL(script.scriptPath)
				insertAndRemoveScript(externalScript)
			}
		}
		Reflect.set(globalThis, 'interceptorInjected', true)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
		throw error
	}
}

injectPageWorldScripts()

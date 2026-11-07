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
		const pageWorldProviderScriptPath = '[[pageWorldProviderScriptPath]]'
		const scriptTag = document.createElement('script')
		scriptTag.async = false
		scriptTag.src = browser.runtime.getURL(pageWorldProviderScriptPath)
		container.insertBefore(scriptTag, container.children[1])
		;(globalThis as unknown as { interceptorInjected?: boolean }).interceptorInjected = true
		container.removeChild(scriptTag)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
	}
}

injectPageWorldScripts()

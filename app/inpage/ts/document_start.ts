function injectPageWorldScripts() {
	if ((globalThis as unknown as { interceptorInjected: true | undefined }).interceptorInjected) return
	;(globalThis as unknown as { interceptorInjected?: boolean }).interceptorInjected = true

	const checkAndThrowRuntimeLastError = () => {
		const error: browser.runtime._LastError | undefined | null = browser.runtime.lastError // firefox returns `null` when there is no error
		if (error !== null && error !== undefined && error.message !== undefined) throw new Error(error.message)
	}

	try {
		const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
		if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
		contentScriptListener(undefined, 'document-start')
		const container = document.head || document.documentElement
		const injectScriptElement = (scriptTag: HTMLScriptElement) => {
			container.insertBefore(scriptTag, container.children[1])
			container.removeChild(scriptTag)
		}
		const injectExternalScript = (scriptPath: string) => {
			const scriptTag = document.createElement('script')
			scriptTag.async = false
			scriptTag.src = browser.runtime.getURL(scriptPath)
			injectScriptElement(scriptTag)
		}
		const pageWorldScriptPathsByCompatibilityMode: { readonly disabled: readonly string[], readonly enabled: readonly string[] } = JSON.parse('[[pageWorldScriptPaths]]')
		const metamaskCompatibilityMode = Reflect.get(globalThis, Symbol.for('[[metamaskCompatibilityModeGlobalSymbolKey]]'))
		if (typeof metamaskCompatibilityMode !== 'boolean') throw new Error('MetaMask compatibility mode was not initialized')
		const pageWorldScriptPaths = metamaskCompatibilityMode ? pageWorldScriptPathsByCompatibilityMode.enabled : pageWorldScriptPathsByCompatibilityMode.disabled
		for (const scriptPath of pageWorldScriptPaths) injectExternalScript(scriptPath)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.error('Interceptor: Provider injection failed.', error)
	}
}

injectPageWorldScripts()

// Claims this document's isolated world for the first content script bridge, as the first statement, so it connects to the background once even when two content script registrations match the page, or when a registration has already marked the page's origin as disabled. contentScriptsUpdating.ts writes the same key.
const isFirstInterceptorBridgeInDocument = !Reflect.has(globalThis, Symbol.for('TheInterceptor.contentScriptBridge')) && Reflect.defineProperty(globalThis, Symbol.for('TheInterceptor.contentScriptBridge'), { value: true, configurable: true })
if (isFirstInterceptorBridgeInDocument) {
	const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
	if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
	contentScriptListener(undefined, 'content-script')
}

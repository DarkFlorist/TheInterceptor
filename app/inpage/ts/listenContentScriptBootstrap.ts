// Connects the bridge once per document, as the first statements. A Firefox disabled-host registration's origin check marks a disabled origin for this copy only, which consumes the mark and skips without claiming the document, so another registration that matches the page still connects. Otherwise the first copy claims the document. The keys repeat app/ts/utils/contentScriptDocumentMarkers.ts, which this classic script cannot import.
const interceptorBridgeSkipsDisabledOrigin = Reflect.has(globalThis, Symbol.for('TheInterceptor.contentScriptBridgeOnDisabledOrigin')) && Reflect.deleteProperty(globalThis, Symbol.for('TheInterceptor.contentScriptBridgeOnDisabledOrigin'))
const isFirstInterceptorBridgeInDocument = !interceptorBridgeSkipsDisabledOrigin && !Reflect.has(globalThis, Symbol.for('TheInterceptor.contentScriptBridge')) && Reflect.defineProperty(globalThis, Symbol.for('TheInterceptor.contentScriptBridge'), { value: true, configurable: true })
if (isFirstInterceptorBridgeInDocument) {
	const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
	if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
	contentScriptListener(undefined, 'content-script')
}

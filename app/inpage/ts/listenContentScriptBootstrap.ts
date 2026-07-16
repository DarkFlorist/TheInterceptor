const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
contentScriptListener(undefined, 'content-script')

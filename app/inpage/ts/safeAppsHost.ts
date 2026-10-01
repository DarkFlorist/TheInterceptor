import { createSafeAppsErrorResponse, createSafeAppsCancellation, isSafeAppsRequest, isSafeAppsResponse, type SafeAppsRequest } from './safeAppsProtocol.js'
import { createSafeAppsRequestQueue } from './safeAppsRequestQueue.js'

// Adapts parent-based Safe SDK messaging to the authorized same-window bridge. Only register the bootstrap on explicitly selected HTTP(S) origins, before the app runs.
export function installSafeAppsHost() {
	// Leave existing parent emulation intact if this bootstrap is loaded again.
	if (window.top !== window || window.parent !== window) return
	const container = document.documentElement
	if (container === null) return
	const frame = document.createElement('iframe')
	frame.style.display = 'none'
	frame.setAttribute('aria-hidden', 'true')
	frame.tabIndex = -1
	container.append(frame)
	const apparentParent = frame.contentWindow
	if (apparentParent === null) return
	const actualPostMessage = window.postMessage.bind(window)
	const originalSetTimeout = window.setTimeout.bind(window)
	const originalClearTimeout = window.clearTimeout.bind(window)
	const pendingRequests = createSafeAppsRequestQueue<SafeAppsRequest>({
		replaceOldestSafeInfo: true,
		timers: { setTimeout: originalSetTimeout, clearTimeout: originalClearTimeout },
		onRejected: (request, error, reason) => {
			if (reason === 'expired' || reason === 'superseded') actualPostMessage(createSafeAppsCancellation(request.id), window.location.origin)
			const deliver = () => window.dispatchEvent(new MessageEvent('message', { data: createSafeAppsErrorResponse(request, error), origin: window.location.origin, source: apparentParent }))
			// Let the SDK install its response listener after posting a request.
			if (reason === 'expired') deliver()
			else queueMicrotask(deliver)
		},
	})
	// Listen on the real frame: native postMessage supplies the actual caller's source and origin.
	apparentParent.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const message = event.data
		if (!isSafeAppsRequest(message)) return
		if (!pendingRequests.add(message)) return
		actualPostMessage(message, window.location.origin)
	})
	Object.defineProperty(window, 'parent', { configurable: true, value: apparentParent })
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const response: unknown = event.data
		if (!isSafeAppsResponse(response)) return
		if (pendingRequests.take(response.id) === undefined) return
		window.dispatchEvent(new MessageEvent('message', { data: response, origin: event.origin, source: apparentParent }))
	})
}

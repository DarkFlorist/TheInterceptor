import { createSafeAppsErrorResponse, createSafeAppsCancellation, isSafeAppsRequest, isSafeAppsResponse, SAFE_APPS_REQUEST_TIMEOUT_MS, SAFE_APPS_PENDING_REQUEST_LIMIT } from './safeAppsProtocol.js'

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
	const pendingRequests = new Map<string, { readonly timeoutId: number, readonly method: string }>()
	const actualPostMessage = window.postMessage.bind(window)
	const originalSetTimeout = window.setTimeout.bind(window)
	const originalClearTimeout = window.clearTimeout.bind(window)
	// Listen on the real frame: native postMessage supplies the actual caller's source and origin.
	apparentParent.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const message = event.data
		if (!isSafeAppsRequest(message)) return
		// Abandoned discovery retries must not starve later SDK operations. Evict only read-only getSafeInfo probes.
		if (!pendingRequests.has(message.id) && pendingRequests.size >= SAFE_APPS_PENDING_REQUEST_LIMIT) {
			const oldestDiscovery = [...pendingRequests].find(([, pending]) => pending.method === 'getSafeInfo')
			if (oldestDiscovery !== undefined) {
				const [id, pending] = oldestDiscovery
				pendingRequests.delete(id)
				originalClearTimeout(pending.timeoutId)
				actualPostMessage(createSafeAppsCancellation(id), window.location.origin)
				queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: createSafeAppsErrorResponse({ id }, 'Safe discovery was superseded by a newer request.'), origin: window.location.origin, source: apparentParent })))
			}
		}
		if (pendingRequests.has(message.id) || pendingRequests.size >= SAFE_APPS_PENDING_REQUEST_LIMIT) {
			const error = pendingRequests.has(message.id) ? 'Duplicate Safe Apps request ID.' : 'Too many pending Safe Apps requests.'
			queueMicrotask(() => {
				window.dispatchEvent(new MessageEvent('message', {
					data: createSafeAppsErrorResponse(message, error),
					origin: window.location.origin,
					source: apparentParent,
				}))
			})
			return
		}
		// Every SDK request expires, including discovery, so unanswered probes cannot permanently exhaust capacity.
		const timeoutId = originalSetTimeout(() => {
			pendingRequests.delete(message.id)
			actualPostMessage(createSafeAppsCancellation(message.id), window.location.origin)
			window.dispatchEvent(new MessageEvent('message', {
				data: createSafeAppsErrorResponse(message, 'Safe Apps request timed out.'),
				origin: window.location.origin,
				source: apparentParent,
			}))
		}, SAFE_APPS_REQUEST_TIMEOUT_MS)
		pendingRequests.set(message.id, { timeoutId, method: message.method })
		actualPostMessage(message, window.location.origin)
	})
	Object.defineProperty(window, 'parent', { configurable: true, value: apparentParent })
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const response: unknown = event.data
		if (!isSafeAppsResponse(response)) return
		const pendingRequest = pendingRequests.get(response.id)
		if (pendingRequest === undefined) return
		pendingRequests.delete(response.id)
		originalClearTimeout(pendingRequest.timeoutId)
		window.dispatchEvent(new MessageEvent('message', { data: response, origin: event.origin, source: apparentParent }))
	})
}

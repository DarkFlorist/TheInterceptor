import { createSafeAppsErrorResponse, isSafeAppsRequest, isSafeAppsResponse } from './safeAppsProtocol.js'

// Adapts parent-based Safe SDK messaging to the authorized same-window bridge. Only register the bootstrap on explicitly selected HTTP(S) origins, before the app runs.
export function installSafeAppsHost() {
	const requestTimeoutMs = 5 * 60_000

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
	const pendingRequests = new Map<string, { readonly timeoutId: number | undefined }>()
	const actualPostMessage = window.postMessage.bind(window)
	const originalParentPostMessage = apparentParent.postMessage.bind(apparentParent)
	const originalSetTimeout = window.setTimeout.bind(window)
	const originalClearTimeout = window.clearTimeout.bind(window)
	Object.defineProperty(apparentParent, 'postMessage', {
		configurable: true,
		value: (message: unknown, targetOrigin = '/', transfer?: Transferable[]) => {
			if (!isSafeAppsRequest(message)) return originalParentPostMessage(message, targetOrigin, transfer ?? [])
			if (targetOrigin !== '*' && targetOrigin !== '/' && targetOrigin !== window.location.origin) return
			if (pendingRequests.has(message.id) || pendingRequests.size >= 32) {
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
			// Discovery follows the bridge's approval lifecycle and can remain pending until a Safe becomes eligible.
			const timeoutId = message.method === 'getSafeInfo' ? undefined : originalSetTimeout(() => {
				pendingRequests.delete(message.id)
				window.dispatchEvent(new MessageEvent('message', {
					data: createSafeAppsErrorResponse(message, 'Safe Apps request timed out.'),
					origin: window.location.origin,
					source: apparentParent,
				}))
			}, requestTimeoutMs)
			pendingRequests.set(message.id, { timeoutId })
			actualPostMessage(message, window.location.origin)
		},
	})
	Object.defineProperty(window, 'parent', { configurable: true, value: apparentParent })
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const response: unknown = event.data
		if (!isSafeAppsResponse(response)) return
		const pendingRequest = pendingRequests.get(response.id)
		if (pendingRequest === undefined) return
		pendingRequests.delete(response.id)
		if (pendingRequest.timeoutId !== undefined) originalClearTimeout(pendingRequest.timeoutId)
		window.dispatchEvent(new MessageEvent('message', { data: response, origin: event.origin, source: apparentParent }))
	})
}

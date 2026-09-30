// Adapts parent-based Safe SDK messaging to the authorized same-window bridge. Only register the bootstrap on explicitly selected HTTP(S) origins, before the app runs.
export function installSafeAppsHost(createDiscoveryAdapter?: () => (() => void) | undefined) {
	const requestTimeoutMs = 5 * 60_000
	const isSafeAppsRequest = (value: unknown): value is { readonly id: string, readonly method: string, readonly env: { readonly sdkVersion: string } } => {
		if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('method' in value) || typeof value.method !== 'string') return false
		if (!('env' in value) || typeof value.env !== 'object' || value.env === null || !('sdkVersion' in value.env)) return false
		return typeof value.env.sdkVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.env.sdkVersion)
	}

	// Avoid installing a second host while old and new registrations overlap during an update.
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
	const onSafeInfoRequest = createDiscoveryAdapter?.()
	Object.defineProperty(apparentParent, 'postMessage', {
		configurable: true,
		value: (message: unknown, targetOrigin = '/', transfer?: Transferable[]) => {
			if (!isSafeAppsRequest(message)) return originalParentPostMessage(message, targetOrigin, transfer ?? [])
			if (targetOrigin !== '*' && targetOrigin !== '/' && targetOrigin !== window.location.origin) return
			if (pendingRequests.has(message.id) || pendingRequests.size >= 32) {
				const error = pendingRequests.has(message.id) ? 'Duplicate Safe Apps request ID.' : 'Too many pending Safe Apps requests.'
				queueMicrotask(() => {
					window.dispatchEvent(new MessageEvent('message', {
						data: { id: message.id, success: false, error, version: message.env.sdkVersion },
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
					data: { id: message.id, success: false, error: 'Safe Apps request timed out.', version: message.env.sdkVersion },
					origin: window.location.origin,
					source: apparentParent,
				}))
			}, requestTimeoutMs)
			pendingRequests.set(message.id, { timeoutId })
			if (message.method === 'getSafeInfo') onSafeInfoRequest?.()
			actualPostMessage(message, window.location.origin)
		},
	})
	Object.defineProperty(window, 'parent', { configurable: true, value: apparentParent })
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return
		const response: unknown = event.data
		if (typeof response !== 'object' || response === null || !('id' in response) || typeof response.id !== 'string' || !('success' in response) || typeof response.success !== 'boolean') return
		const pendingRequest = pendingRequests.get(response.id)
		if (pendingRequest === undefined) return
		pendingRequests.delete(response.id)
		if (pendingRequest.timeoutId !== undefined) originalClearTimeout(pendingRequest.timeoutId)
		window.dispatchEvent(new MessageEvent('message', { data: response, origin: event.origin, source: apparentParent }))
	})
}

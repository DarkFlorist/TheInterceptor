// Bridge Request Finance's iframe-only Safe SDK to Interceptor's same-window Safe Apps handler.
(() => {
	const isSafeAppsRequest = (value: unknown): value is { readonly id: string, readonly method: string, readonly env: { readonly sdkVersion: string } } => {
		if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('method' in value) || typeof value.method !== 'string') return false
		if (!('env' in value) || typeof value.env !== 'object' || value.env === null || !('sdkVersion' in value.env)) return false
		return typeof value.env.sdkVersion === 'string'
	}

	if (window.top !== window || window.location.origin !== 'https://app.request.finance') return
	const container = document.documentElement
	if (container !== null) {
		const frame = document.createElement('iframe')
		frame.style.display = 'none'
		frame.setAttribute('aria-hidden', 'true')
		frame.tabIndex = -1
		container.append(frame)
		const apparentParent = frame.contentWindow
		if (apparentParent !== null) {
			const pendingRequests = new Set<string>()
			const actualPostMessage = window.postMessage.bind(window)
			const originalParentPostMessage = apparentParent.postMessage.bind(apparentParent)
			const originalSetTimeout = window.setTimeout.bind(window)
			let safeInfoTimeoutExpected = false
			Object.defineProperty(window, 'setTimeout', {
				configurable: true,
				value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
					// Request Finance races Safe discovery against a 200 ms timer immediately after posting getSafeInfo.
					const safeInfoTimeout = safeInfoTimeoutExpected && timeout === 200
					if (safeInfoTimeout) safeInfoTimeoutExpected = false
					return originalSetTimeout(handler, safeInfoTimeout ? 10_000 : timeout, ...args)
				},
			})
			Object.defineProperty(apparentParent, 'postMessage', {
				configurable: true,
				value: (message: unknown, targetOrigin: string, transfer?: Transferable[]) => {
					if (!isSafeAppsRequest(message)) return originalParentPostMessage(message, targetOrigin, transfer ?? [])
					if (pendingRequests.size >= 32) {
						queueMicrotask(() => {
							window.dispatchEvent(new MessageEvent('message', {
								data: { id: message.id, success: false, error: 'Too many pending Safe Apps requests.', version: message.env.sdkVersion },
								origin: window.location.origin,
								source: apparentParent,
							}))
						})
						return
					}
					pendingRequests.add(message.id)
					if (message.method === 'getSafeInfo') {
						safeInfoTimeoutExpected = true
						queueMicrotask(() => { safeInfoTimeoutExpected = false })
					}
					actualPostMessage(message, window.location.origin)
				},
			})
			Object.defineProperty(window, 'parent', { configurable: true, value: apparentParent })
			window.addEventListener('message', (event) => {
				if (event.source !== window || event.origin !== window.location.origin) return
				const response: unknown = event.data
				if (typeof response !== 'object' || response === null || !('id' in response) || typeof response.id !== 'string' || !pendingRequests.has(response.id) || !('success' in response) || typeof response.success !== 'boolean') return
				pendingRequests.delete(response.id)
				window.dispatchEvent(new MessageEvent('message', { data: response, origin: event.origin, source: apparentParent }))
			})
		}
	}
})()

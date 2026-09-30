// Request Finance posts getSafeInfo and immediately races it against a 200 ms timer. Keep this site policy separate from the reusable SDK transport.
export function installRequestFinanceDiscoveryAdapter(): (() => void) | undefined {
	if (window.top !== window || window.location.origin !== 'https://app.request.finance') return undefined
	const originalSetTimeout = window.setTimeout.bind(window)
	let safeInfoTimeoutExpected = false
	Object.defineProperty(window, 'setTimeout', {
		configurable: true,
		value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			const safeInfoTimeout = safeInfoTimeoutExpected && timeout === 200
			if (safeInfoTimeout) safeInfoTimeoutExpected = false
			// Approval or rejection settles the SDK race; a timer must not interrupt user consent.
			return originalSetTimeout(safeInfoTimeout ? () => undefined : handler, timeout, ...args)
		},
	})
	return () => {
		safeInfoTimeoutExpected = true
		queueMicrotask(() => { safeInfoTimeoutExpected = false })
	}
}

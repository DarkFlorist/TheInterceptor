// Serialized into the native iframe fixture. Discovery is bounded; approvals deliberately have no SDK deadline and are never replayed.
export function createNativeGnosisSafeAppsFixtureClient(expectedParentOrigin: string) {
	const replies: unknown[] = []
	const deliveries: unknown[] = []
	const timings: { id: string, method: string, started: number, deadline?: number, received?: number, expired?: number }[] = []
	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (event.source !== window.parent || event.origin !== expectedParentOrigin || typeof event.data !== 'object' || event.data === null || !('id' in event.data) || typeof event.data.id !== 'string' || !('success' in event.data)) return
		deliveries.push({ origin: event.origin, at: performance.now(), reply: event.data })
	})
	const request = (method: string, params?: unknown, deadline: number | undefined = method === 'getSafeInfo' || method === 'getChainInfo' || method === 'getEnvironmentInfo' ? 15_000 : undefined, env = { sdkVersion: '9.1.0' }) => new Promise<unknown>((resolve, reject) => {
		const id = crypto.randomUUID()
		const timing: (typeof timings)[number] = { id, method, started: performance.now(), ...(deadline === undefined ? {} : { deadline }) }
		timings.push(timing)
		let timer: ReturnType<typeof setTimeout> | undefined
		const receive = (event: MessageEvent<unknown>) => {
			if (event.source !== window.parent || event.origin !== expectedParentOrigin || typeof event.data !== 'object' || event.data === null || !('id' in event.data) || event.data.id !== id) return
			timing.received = performance.now()
			replies.push({ origin: event.origin, sourceIsParent: event.source === window.parent, reply: event.data })
			if (timer !== undefined) clearTimeout(timer)
			window.removeEventListener('message', receive)
			resolve(event.data)
		}
		if (deadline !== undefined) timer = setTimeout(() => {
			timing.expired = performance.now()
			window.removeEventListener('message', receive)
			reject(new Error('SDK deadline expired'))
		}, deadline)
		window.addEventListener('message', receive)
		window.parent.postMessage({ id, method, env, ...(params === undefined ? {} : { params }) }, '*')
	})
	return { request, replies, deliveries, timings }
}

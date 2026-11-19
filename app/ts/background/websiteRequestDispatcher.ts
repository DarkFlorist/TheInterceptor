import type { InterceptedRequest } from '../utils/requests.js'

// One dispatcher serves all connections. Active work and queued backlog are both bounded across frames and origins.
export function createWebsiteRequestDispatcher(isCapacityReleasingRequest: (request: InterceptedRequest) => boolean, { maxPendingRequests = 40, maxPendingRequestsPerOrigin = 20, maxQueuedRequests = 2000, maxQueuedRequestsPerOrigin = 1000 } = {}) {
	let pendingRequests = 0
	const pendingRequestsByOrigin = new Map<string, number>()
	const queuedRequestsByOrigin = new Map<string, number>()
	const queue: { origin: string, start: () => void }[] = []
	const hasCapacity = (origin: string) => pendingRequests < maxPendingRequests && (pendingRequestsByOrigin.get(origin) ?? 0) < maxPendingRequestsPerOrigin
	const decrement = (counts: Map<string, number>, origin: string) => {
		const remaining = (counts.get(origin) ?? 1) - 1
		if (remaining === 0) counts.delete(origin)
		else counts.set(origin, remaining)
	}
	const drainQueue = () => {
		// Preserve arrival order among eligible requests; a saturated origin must not block another origin's work.
		while (pendingRequests < maxPendingRequests) {
			const index = queue.findIndex(({ origin }) => hasCapacity(origin))
			if (index === -1) return
			const next = queue.splice(index, 1)[0]
			if (next === undefined) throw new Error('Missing queued website request')
			decrement(queuedRequestsByOrigin, next.origin)
			next.start()
		}
	}
	const run = async <T>(origin: string, handle: () => Promise<T>): Promise<T> => {
		pendingRequests += 1
		pendingRequestsByOrigin.set(origin, (pendingRequestsByOrigin.get(origin) ?? 0) + 1)
		try {
			return await handle()
		} finally {
			pendingRequests -= 1
			decrement(pendingRequestsByOrigin, origin)
			drainQueue()
		}
	}
	return async <T>(websiteOrigin: string, request: InterceptedRequest, handle: () => Promise<T>, refuse: () => T | Promise<T>): Promise<T> => {
		// Completion callbacks bypass active and backlog limits so saturated requests can still finish.
		if (isCapacityReleasingRequest(request)) return await handle()
		if (hasCapacity(websiteOrigin)) return await run(websiteOrigin, handle)
		const queuedForOrigin = queuedRequestsByOrigin.get(websiteOrigin) ?? 0
		if (queue.length >= maxQueuedRequests || queuedForOrigin >= maxQueuedRequestsPerOrigin) return await refuse()
		return await new Promise<T>((resolve, reject) => {
			queuedRequestsByOrigin.set(websiteOrigin, queuedForOrigin + 1)
			queue.push({ origin: websiteOrigin, start: () => { void run(websiteOrigin, handle).then(resolve, reject) } })
		})
	}
}

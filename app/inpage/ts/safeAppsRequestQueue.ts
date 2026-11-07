import { SAFE_APPS_PENDING_REQUEST_LIMIT, SAFE_APPS_REQUEST_TIMEOUT_MS, type SafeAppsRequest } from './safeAppsProtocol.js'

type QueueRejection = 'duplicate' | 'capacity' | 'expired' | 'superseded'
const rejectionMessages = {
	duplicate: 'Duplicate Safe Apps request ID.',
	capacity: 'Too many pending Safe Apps requests.',
	expired: 'Safe Apps request timed out.',
	superseded: 'Safe discovery was superseded by a newer request.',
}
type QueueOptions<T> = {
	readonly onRejected: (request: T, error: string, reason: QueueRejection) => void
	// The host sees abandoned SDK retries; the provider retains discovery until eligibility returns.
	readonly replaceOldestSafeInfo?: boolean
	// Without a scheduler, callers expire entries on messages and eligibility changes.
	readonly timers?: { readonly setTimeout: (callback: () => void, delay: number) => number, readonly clearTimeout: (id: number) => void }
	// Defaults to expiring every entry. Return false for requests that may still complete after the deadline, so they stay pending until answered or taken.
	readonly expires?: (request: T) => boolean
}

// Shared capacity, duplicate-ID, expiry and removal policy; callers own message delivery and eligibility.
export function createSafeAppsRequestQueue<T extends Pick<SafeAppsRequest, 'id' | 'method'>>(options: QueueOptions<T>) {
	type Entry = { readonly request: T, readonly expiresAt: number | undefined, timeoutId?: number }
	const entries = new Map<string, Entry>()
	const take = (id: string) => {
		const entry = entries.get(id)
		if (entry === undefined) return undefined
		entries.delete(id)
		if (entry.timeoutId !== undefined) options.timers?.clearTimeout(entry.timeoutId)
		return entry.request
	}
	const reject = (id: string, reason: QueueRejection) => {
		const request = take(id)
		if (request !== undefined) options.onRejected(request, rejectionMessages[reason], reason)
	}
	const expire = () => {
		const now = Date.now()
		for (const [id, entry] of entries) if (entry.expiresAt !== undefined && entry.expiresAt <= now) reject(id, 'expired')
	}
	return {
		add(request: T) {
			expire()
			if (entries.has(request.id)) {
				options.onRejected(request, rejectionMessages.duplicate, 'duplicate')
				return false
			}
			if (entries.size >= SAFE_APPS_PENDING_REQUEST_LIMIT && options.replaceOldestSafeInfo === true) {
				const oldestDiscovery = [...entries.values()].find(({ request }) => request.method === 'getSafeInfo')
				if (oldestDiscovery !== undefined) reject(oldestDiscovery.request.id, 'superseded')
			}
			if (entries.size >= SAFE_APPS_PENDING_REQUEST_LIMIT) {
				options.onRejected(request, rejectionMessages.capacity, 'capacity')
				return false
			}
			if (options.expires?.(request) === false) {
				entries.set(request.id, { request, expiresAt: undefined })
				return true
			}
			const entry: Entry = { request, expiresAt: Date.now() + SAFE_APPS_REQUEST_TIMEOUT_MS }
			entries.set(request.id, entry)
			entry.timeoutId = options.timers?.setTimeout(() => {
				// A cancelled/completed ID may have been reused before an old callback runs.
				if (entries.get(request.id) === entry) reject(request.id, 'expired')
			}, SAFE_APPS_REQUEST_TIMEOUT_MS)
			return true
		},
		// Completion and cancellation both remove the entry and release its timer without a reply.
		take,
		expire,
		values: () => [...entries.values()].map(({ request }) => request),
		drain() {
			const requests: T[] = []
			for (const id of entries.keys()) {
				const request = take(id)
				if (request !== undefined) requests.push(request)
			}
			return requests
		},
	}
}

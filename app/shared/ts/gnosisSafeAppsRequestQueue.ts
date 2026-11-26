import { GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT, GNOSIS_SAFE_APPS_REQUEST_TIMEOUT_MS, type GnosisSafeAppsRequest } from './gnosisSafeAppsProtocol.js'

type QueueRejection = 'duplicate' | 'capacity' | 'expired'
const rejectionMessages = {
	duplicate: 'Duplicate Gnosis Safe Apps request ID.',
	capacity: 'Too many pending Gnosis Safe Apps requests.',
	expired: 'Gnosis Safe Apps request timed out.',
}
type QueueOptions<T> = {
	readonly timeoutMs?: number
	readonly onRejected: (request: T, error: string, reason: QueueRejection) => void
	// Without a scheduler, callers expire entries on messages and eligibility changes.
	readonly timers?: { readonly setTimeout: (callback: () => void, delay: number) => number, readonly clearTimeout: (id: number) => void }
	// Defaults to expiring every entry. Return false for requests that may still complete after the deadline, so they stay pending until answered or taken.
	readonly expires?: (request: T) => boolean
}

// Shared capacity, duplicate-ID, expiry and removal policy; callers own message delivery and eligibility.
export function createGnosisSafeAppsRequestQueue<T extends Pick<GnosisSafeAppsRequest, 'id' | 'method'>>(options: QueueOptions<T>) {
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
			if (entries.size >= GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT) {
				options.onRejected(request, rejectionMessages.capacity, 'capacity')
				return false
			}
			if (options.expires?.(request) === false) {
				entries.set(request.id, { request, expiresAt: undefined })
				return true
			}
			const entry: Entry = { request, expiresAt: Date.now() + (options.timeoutMs ?? GNOSIS_SAFE_APPS_REQUEST_TIMEOUT_MS) }
			entries.set(request.id, entry)
			entry.timeoutId = options.timers?.setTimeout(() => {
				// A cancelled/completed ID may have been reused before an old callback runs.
				if (entries.get(request.id) === entry) reject(request.id, 'expired')
			}, options.timeoutMs ?? GNOSIS_SAFE_APPS_REQUEST_TIMEOUT_MS)
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

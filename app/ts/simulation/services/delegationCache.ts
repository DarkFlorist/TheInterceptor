import { addressString } from '../../utils/bigint.js'
import { NEW_BLOCK_ABORT } from '../../utils/constants.js'

const DELEGATION_CACHE_AGE_MS = 5 * 60 * 1000
type PendingLookup = { promise: Promise<bigint | undefined>, controller: AbortController, waiters: number, settled: boolean }

export function createDelegationCache(lookup: (address: bigint, controller: AbortController) => Promise<bigint | undefined>) {
	let generation = 0
	const resolved = new Map<string, { checkedAt: number, delegate: bigint | undefined }>()
	const pendingByAddress = new Map<string, PendingLookup>()

	const clear = () => {
		generation += 1
		resolved.clear()
		for (const pending of pendingByAddress.values()) pending.controller.abort(NEW_BLOCK_ABORT)
		pendingByAddress.clear()
	}

	const startLookup = (address: bigint, key: string): PendingLookup => {
		const controller = new AbortController()
		const lookupGeneration = generation
		const pending: PendingLookup = { promise: lookup(address, controller), controller, waiters: 0, settled: false }
		pending.promise = pending.promise.then((delegate) => {
			if (controller.signal.aborted || generation !== lookupGeneration) throw NEW_BLOCK_ABORT
			resolved.set(key, { checkedAt: Date.now(), delegate })
			return delegate
		}).finally(() => {
			pending.settled = true
			if (pendingByAddress.get(key) === pending) pendingByAddress.delete(key)
		})
		pendingByAddress.set(key, pending)
		return pending
	}

	const get = async (address: bigint, abortController?: AbortController, refresh = false) => {
		if (abortController?.signal.aborted) throw abortController.signal.reason ?? NEW_BLOCK_ABORT
		const key = addressString(address)
		const cached = resolved.get(key)
		if (!refresh && cached !== undefined && Date.now() - cached.checkedAt < DELEGATION_CACHE_AGE_MS) return cached.delegate
		const pending = pendingByAddress.get(key) ?? startLookup(address, key)
		pending.waiters += 1
		const signal = abortController?.signal
		let rejectAborted: (reason: unknown) => void = () => undefined
		const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
		const onAbort = () => { rejectAborted(signal?.reason ?? NEW_BLOCK_ABORT) }
		signal?.addEventListener('abort', onAbort, { once: true })
		try {
			if (signal?.aborted) onAbort()
			return await Promise.race([pending.promise, aborted])
		} finally {
			signal?.removeEventListener('abort', onAbort)
			pending.waiters -= 1
			if (pending.waiters === 0 && !pending.settled) {
				pending.controller.abort(NEW_BLOCK_ABORT)
				if (pendingByAddress.get(key) === pending) pendingByAddress.delete(key)
			}
		}
	}

	return { get, clear }
}

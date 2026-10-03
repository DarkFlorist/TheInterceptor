import { addressString } from '../../utils/bigint.js'
import { NEW_BLOCK_ABORT } from '../../utils/constants.js'

const DELEGATION_CACHE_AGE_MS = 5 * 60 * 1000
type PendingLookup = { promise: Promise<bigint | undefined>, controller: AbortController, generation: number }

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
		let rejectInvalidated: (reason: unknown) => void = () => undefined
		const invalidated = new Promise<never>((_resolve, reject) => { rejectInvalidated = reject })
		const onInvalidate = () => { rejectInvalidated(NEW_BLOCK_ABORT) }
		controller.signal.addEventListener('abort', onInvalidate, { once: true })
		const pending: PendingLookup = { promise: Promise.race([lookup(address, controller), invalidated]), controller, generation: lookupGeneration }
		pending.promise = pending.promise.then((delegate) => {
			if (controller.signal.aborted || generation !== lookupGeneration) throw NEW_BLOCK_ABORT
			resolved.set(key, { checkedAt: Date.now(), delegate })
			return delegate
		}).finally(() => {
			controller.signal.removeEventListener('abort', onInvalidate)
			if (pendingByAddress.get(key) === pending) pendingByAddress.delete(key)
		})
		pendingByAddress.set(key, pending)
		return pending
	}

	const get = async (address: bigint, abortController?: AbortController, refresh = false) => {
		if (abortController?.signal.aborted) throw abortController.signal.reason ?? NEW_BLOCK_ABORT
		const key = addressString(address)
		let skipCached = refresh
		const signal = abortController?.signal
		let rejectAborted: (reason: unknown) => void = () => undefined
		const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
		const onAbort = () => { rejectAborted(signal?.reason ?? NEW_BLOCK_ABORT) }
		signal?.addEventListener('abort', onAbort, { once: true })
		try {
			if (signal?.aborted) onAbort()
			for (;;) {
				if (signal?.aborted) throw signal.reason ?? NEW_BLOCK_ABORT
				if (!skipCached) {
					const cached = resolved.get(key)
					if (cached !== undefined && Date.now() - cached.checkedAt < DELEGATION_CACHE_AGE_MS) return cached.delegate
				}
				skipCached = false
				const pending = pendingByAddress.get(key) ?? startLookup(address, key)
				try {
					return await Promise.race([pending.promise, aborted])
				} catch (error) {
					if (signal?.aborted) throw signal.reason ?? NEW_BLOCK_ABORT
					if (pending.generation === generation) throw error
				}
			}
		} finally {
			signal?.removeEventListener('abort', onAbort)
		}
	}

	return { get, clear }
}

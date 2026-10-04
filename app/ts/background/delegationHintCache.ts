import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { addressString } from '../utils/bigint.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'

const DELEGATION_CACHE_AGE_MS = 5 * 60 * 1000
const DELEGATED_HINT_REFRESH_MIN_AGE_MS = 60 * 1000
type PendingLookup = { promise: Promise<bigint | undefined>, controller: AbortController, generation: number }

function createDelegationCache(lookup: (address: bigint, controller: AbortController) => Promise<bigint | undefined>) {
	let generation = 0
	const resolved = new Map<string, { checkedAt: number, delegate: bigint | undefined }>()
	const pendingByAddress = new Map<string, PendingLookup>()

	const invalidatePending = () => {
		generation += 1
		for (const pending of pendingByAddress.values()) pending.controller.abort(NEW_BLOCK_ABORT)
		pendingByAddress.clear()
	}

	const clear = () => {
		invalidatePending()
		resolved.clear()
	}

	const invalidateDelegatedForNewBlock = (now: number) => {
		// A lookup begun before this block cannot safely publish its result as a fresh hint.
		invalidatePending()
		for (const [key, cached] of resolved) {
			if (cached.delegate !== undefined && now - cached.checkedAt >= DELEGATED_HINT_REFRESH_MIN_AGE_MS) resolved.delete(key)
		}
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

	const get = async (address: bigint, abortController?: AbortController) => {
		if (abortController?.signal.aborted) throw abortController.signal.reason ?? NEW_BLOCK_ABORT
		const key = addressString(address)
		const signal = abortController?.signal
		let rejectAborted: (reason: unknown) => void = () => undefined
		const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
		const onAbort = () => { rejectAborted(signal?.reason ?? NEW_BLOCK_ABORT) }
		signal?.addEventListener('abort', onAbort, { once: true })
		try {
			if (signal?.aborted) onAbort()
			for (;;) {
				if (signal?.aborted) throw signal.reason ?? NEW_BLOCK_ABORT
				const cached = resolved.get(key)
				if (cached !== undefined && Date.now() - cached.checkedAt < DELEGATION_CACHE_AGE_MS) return cached.delegate
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

	return { get, clear, invalidateDelegatedForNewBlock }
}

// Hints belong to the RPC service identity. Switching networks creates a new service and a new cache.
const hintCaches = new WeakMap<EthereumClientService, ReturnType<typeof createDelegationCache>>()

function getHintCache(ethereum: EthereumClientService) {
	const existing = hintCaches.get(ethereum)
	if (existing !== undefined) return existing
	const created = createDelegationCache((address, controller) => ethereum.getDelegation(address, 'latest', controller))
	hintCaches.set(ethereum, created)
	return created
}

export const getCachedDelegationHint = (ethereum: EthereumClientService, address: bigint, abortController?: AbortController) =>
	getHintCache(ethereum).get(address, abortController)

export const clearDelegationHintCache = (ethereum: EthereumClientService) => hintCaches.get(ethereum)?.clear()

export const invalidateDelegatedHintsForNewBlock = (ethereum: EthereumClientService, now = Date.now()) => hintCaches.get(ethereum)?.invalidateDelegatedForNewBlock(now)

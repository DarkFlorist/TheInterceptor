import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { addressString } from '../utils/bigint.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'

const DELEGATION_CACHE_AGE_MS = 5 * 60 * 1000
type PendingLookup = { promise: Promise<bigint | undefined>, controller: AbortController, waiters: number, settled: boolean }
type DelegationCache = {
	headHash: bigint | undefined
	generation: number
	resolved: Map<string, { checkedAt: number, delegate: bigint | undefined }>
	pending: Map<string, PendingLookup>
}
const delegationCaches = new WeakMap<EthereumClientService, DelegationCache>()

function getDelegationCache(ethereum: EthereumClientService): DelegationCache {
	const existing = delegationCaches.get(ethereum)
	if (existing !== undefined) return existing
	const created: DelegationCache = { headHash: ethereum.getCachedBlock()?.hash, generation: 0, resolved: new Map(), pending: new Map() }
	delegationCaches.set(ethereum, created)
	return created
}

export function invalidateCachedDelegation(ethereum: EthereumClientService) {
	const cache = delegationCaches.get(ethereum)
	if (cache === undefined) return
	cache.generation += 1
	cache.headHash = ethereum.getCachedBlock()?.hash
	cache.resolved.clear()
	for (const pending of cache.pending.values()) pending.controller.abort(NEW_BLOCK_ABORT)
	cache.pending.clear()
}

function synchronizeCacheWithHead(ethereum: EthereumClientService, cache: DelegationCache) {
	if (cache.headHash !== ethereum.getCachedBlock()?.hash) invalidateCachedDelegation(ethereum)
}

function startLookup(ethereum: EthereumClientService, address: bigint, key: string, cache: DelegationCache): PendingLookup {
	const controller = new AbortController()
	const generation = cache.generation
	const pending: PendingLookup = { promise: ethereum.getDelegation(address, 'latest', controller), controller, waiters: 0, settled: false }
	pending.promise = pending.promise.then((delegate) => {
		if (controller.signal.aborted) throw controller.signal.reason ?? NEW_BLOCK_ABORT
		if (cache.generation !== generation || cache.headHash !== ethereum.getCachedBlock()?.hash) throw NEW_BLOCK_ABORT
		cache.resolved.set(key, { checkedAt: Date.now(), delegate })
		return delegate
	}).finally(() => {
		pending.settled = true
		if (cache.pending.get(key) === pending) cache.pending.delete(key)
	})
	cache.pending.set(key, pending)
	return pending
}

export async function getCachedDelegation(ethereum: EthereumClientService, address: bigint, abortController?: AbortController) {
	if (abortController?.signal.aborted) throw abortController.signal.reason ?? NEW_BLOCK_ABORT
	const cache = getDelegationCache(ethereum)
	synchronizeCacheWithHead(ethereum, cache)
	const key = addressString(address)
	const cached = cache.resolved.get(key)
	if (cached !== undefined && Date.now() - cached.checkedAt < DELEGATION_CACHE_AGE_MS) return cached.delegate
	const pending = cache.pending.get(key) ?? startLookup(ethereum, address, key, cache)
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
			if (cache.pending.get(key) === pending) cache.pending.delete(key)
		}
	}
}

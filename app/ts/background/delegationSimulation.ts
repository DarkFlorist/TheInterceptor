import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { addressString } from '../utils/bigint.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'

const DELEGATION_CACHE_AGE_MS = 5 * 60 * 1000
type DelegationCache = {
	resolved: Map<string, { checkedAt: number, delegate: bigint | undefined }>
	pending: Map<string, Promise<bigint | undefined>>
}
const delegationCaches = new WeakMap<EthereumClientService, DelegationCache>()

function getDelegationCache(ethereum: EthereumClientService): DelegationCache {
	const existing = delegationCaches.get(ethereum)
	if (existing !== undefined) return existing
	const created = { resolved: new Map(), pending: new Map() }
	delegationCaches.set(ethereum, created)
	return created
}

export async function getCachedDelegation(ethereum: EthereumClientService, address: bigint, abortController?: AbortController) {
	if (abortController?.signal.aborted) throw abortController.signal.reason ?? NEW_BLOCK_ABORT
	const cache = getDelegationCache(ethereum)
	const key = addressString(address)
	const cached = cache.resolved.get(key)
	if (cached !== undefined && Date.now() - cached.checkedAt < DELEGATION_CACHE_AGE_MS) return cached.delegate
	let pending = cache.pending.get(key)
	if (pending === undefined) {
		pending = ethereum.getDelegation(address, 'latest', undefined).then((delegate) => {
			cache.resolved.set(key, { checkedAt: Date.now(), delegate })
			return delegate
		}).finally(() => { cache.pending.delete(key) })
		cache.pending.set(key, pending)
	}
	if (abortController === undefined) return await pending
	const signal = abortController.signal
	let rejectAborted: (reason: unknown) => void = () => undefined
	const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
	const onAbort = () => { rejectAborted(signal.reason ?? NEW_BLOCK_ABORT) }
	signal.addEventListener('abort', onAbort, { once: true })
	try {
		if (signal.aborted) throw signal.reason ?? NEW_BLOCK_ABORT
		return await Promise.race([pending, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

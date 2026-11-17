import type { EthereumBlockHeader } from '../types/wire-types.js'
import type { RpcEntry } from '../types/rpc.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { EthereumJSONRpcRequestHandler, type RpcRequestLifecycleCallbacks } from './services/EthereumJSONRpcRequestHandler.js'
import { TokenPriceService } from './services/priceEstimator.js'
import type { ClientLiveness } from './services/clientLiveness.js'

export type NewBlockAttemptCallback = (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => Promise<void>
export type OnErrorBlockCallback = (ethereumClientService: EthereumClientService, error: unknown) => Promise<void>

export type SimulationServices = {
	readonly ethereum: EthereumClientService
	readonly tokenPriceService: TokenPriceService
}

export function createEthereumClientService(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	liveness: ClientLiveness,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	return new EthereumClientService(
		new EthereumJSONRpcRequestHandler(rpcNetwork.httpsRpc, true, rpcRequestLifecycleCallbacks),
		newBlockAttemptCallback,
		onErrorBlockCallback,
		rpcNetwork,
		liveness,
	)
}

export function createSimulationServices(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	liveness: ClientLiveness,
	tokenPriceCacheAge = 60000,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
): SimulationServices {
	const ethereum = createEthereumClientService(
		rpcNetwork,
		newBlockAttemptCallback,
		onErrorBlockCallback,
		liveness,
		rpcRequestLifecycleCallbacks,
	)
	return {
		ethereum,
		tokenPriceService: new TokenPriceService(ethereum, tokenPriceCacheAge),
	}
}

export function resetSimulationServices(
	currentServices: SimulationServices,
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	liveness: ClientLiveness,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
): SimulationServices {
	// Retire background polling; cleanup does not invalidate RPC methods used by an in-flight snapshot.
	currentServices.ethereum.cleanup()
	return createSimulationServices(
		rpcNetwork,
		newBlockAttemptCallback,
		onErrorBlockCallback,
		liveness,
		currentServices.tokenPriceService.cacheAge,
		rpcRequestLifecycleCallbacks,
	)
}

export type SimulationServicesUpdate = {
	// Replacement automatically requests an invalidating refresh after this whole update completes.
	readonly reset: (rpcNetwork: RpcEntry) => SimulationServices
	readonly requestRefresh: () => void
}
export type SimulationServicesUpdateOutcome = { readonly status: 'completed', readonly invalidateOldState: boolean } | { readonly status: 'failed', readonly error: unknown }
export type SimulationServicesUpdateObserver = (services: SimulationServices, outcome: SimulationServicesUpdateOutcome) => Promise<void>
export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServices
	readonly update: <Result>(apply: (update: SimulationServicesUpdate) => Promise<Result>) => Promise<Result>
}

// Replacement is synchronous. Each update tracks its own installed pair and refresh intent; application workflows own their ordering, and an unfinished callback cannot lock out another replacement.
export function createSimulationServicesOwnerFromOperations(getCurrent: () => SimulationServices, replace: SimulationServicesUpdate['reset'], observe: SimulationServicesUpdateObserver): SimulationServicesOwner {
	return {
		getCurrent,
		update: async <Result>(apply: (update: SimulationServicesUpdate) => Promise<Result>): Promise<Result> => {
			const completed = await (async () => {
				let services = getCurrent()
				let refreshRequested = false
				let invalidateOldState = false
				let updateOpen = true
				const requireOpenUpdate = () => { if (!updateOpen) throw new Error('This simulation services update is no longer active') }
				try {
					const result = await apply({
						reset: (network) => { requireOpenUpdate(); refreshRequested = true; invalidateOldState = true; services = getCurrent(); services = replace(network); return services },
						requestRefresh: () => { requireOpenUpdate(); refreshRequested = true; if (!invalidateOldState) services = getCurrent() },
					})
					return { status: 'completed' as const, invalidateOldState, result, services, refreshRequested }
				} catch (error: unknown) {
					return { status: 'failed' as const, error, services, refreshRequested }
				} finally {
					updateOpen = false
				}
			})()
			// The workflow has settled and released its own ordering lock before observing its captured pair.
			if (completed.refreshRequested) {
				const outcome: SimulationServicesUpdateOutcome = completed.status === 'failed' ? { status: 'failed', error: completed.error } : { status: 'completed', invalidateOldState: completed.invalidateOldState }
				await observe(completed.services, outcome)
			}
			if (completed.status === 'failed') throw completed.error
			return completed.result
		},
	}
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	observeUpdate: SimulationServicesUpdateObserver,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	// Advanced by every install. Each client compares the generation it was installed at, so installing a replacement makes every earlier client report itself replaced.
	let installedGeneration = 0
	const livenessAt = (generation: number): ClientLiveness => () => generation === installedGeneration
	let current = createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(installedGeneration), 60000, rpcRequestLifecycleCallbacks)
	return createSimulationServicesOwnerFromOperations(() => current, (nextRpc: RpcEntry): SimulationServices => {
		// The generation advances only once the replacement exists, so a reset that fails to build it leaves the installed services current.
		const nextGeneration = installedGeneration + 1
		const next = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(nextGeneration), rpcRequestLifecycleCallbacks)
		installedGeneration = nextGeneration
		current = next
		return current
	}, observeUpdate)
}

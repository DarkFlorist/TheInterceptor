import type { EthereumBlockHeader } from '../types/wire-types.js'
import { getRpcNetworkChange, getRpcEntryIdentityKey, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'
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

export type SimulationNetworkReconciliation = 'replaced' | 'unchanged' | 'signerOnly'

export type SimulationServicesUpdate = {
	// Reconciles the installed endpoint; RPC-list edits can also request fresh metadata without mutating captured clients. A replacement automatically requests an invalidating refresh after this whole update completes.
	readonly ensureNetwork: (rpcNetwork: RpcNetwork, options?: { readonly updateMetadata?: boolean }) => SimulationNetworkReconciliation
	readonly requestRefresh: () => void
}
type ServiceReplacementOutcome = 'unchanged' | 'replaced' | 'failed'
export type SimulationServicesUpdateOutcome = { readonly replacement: ServiceReplacementOutcome } & ({ readonly status: 'completed' } | { readonly status: 'failed', readonly error: unknown })
type ObserverErrorReporter = (error: unknown) => Promise<void>
export type SimulationServicesUpdateObserver = (services: SimulationServices, outcome: SimulationServicesUpdateOutcome) => Promise<void>
export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServices
	// Scopes one caller's replacements and refresh request, then observes them after the callback settles. It takes no lock and does not serialize callers; `runSimulationSettingsTransition` owns the ordering of application transitions.
	readonly update: <Result>(apply: (update: SimulationServicesUpdate) => Promise<Result>) => Promise<Result>
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	observeUpdate: SimulationServicesUpdateObserver,
	reportObserverError: ObserverErrorReporter,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	// Advanced by every install. Each client compares the generation it was installed at, so installing a replacement makes every earlier client report itself replaced.
	let installedGeneration = 0
	// Clients read the owner only when asked, after it exists.
	const livenessAt = (generation: number): ClientLiveness => ({ isCurrent: () => generation === installedGeneration, installedServices: () => owner.getCurrent() })
	const owner = createSimulationServicesOwnerForServices(
		rpcNetwork,
		createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(installedGeneration), 60000, rpcRequestLifecycleCallbacks),
		(current, nextRpc) => {
			// The generation advances only once the replacement exists, so a reset that fails to build it leaves the installed services current.
			const nextGeneration = installedGeneration + 1
			const next = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(nextGeneration), rpcRequestLifecycleCallbacks)
			installedGeneration = nextGeneration
			return next
		},
		observeUpdate,
		reportObserverError,
	)
	return owner
}

// The owner records the installed selection explicitly, so injected services need not spoof client metadata to participate in reconciliation. Replacement is synchronous. Each update tracks its own installed pair and refresh intent; application workflows own their ordering, and an unfinished callback cannot lock out another replacement.
export function createSimulationServicesOwnerForServices(
	initialNetwork: RpcEntry,
	initial: SimulationServices,
	replace: (current: SimulationServices, network: RpcEntry) => SimulationServices,
	observe: SimulationServicesUpdateObserver,
	reportObserverError: ObserverErrorReporter,
): SimulationServicesOwner {
	let current = initial
	let installedNetwork = initialNetwork
	const getCurrent = () => current
	return {
		getCurrent,
		update: async <Result>(apply: (update: SimulationServicesUpdate) => Promise<Result>): Promise<Result> => {
			const completed = await (async () => {
				let services = getCurrent()
				let refreshRequested = false
				let replacement: ServiceReplacementOutcome = 'unchanged'
				let updateOpen = true
				const requireOpenUpdate = () => { if (!updateOpen) throw new Error('This simulation services update is no longer active') }
				try {
					const result = await apply({
						ensureNetwork: (nextNetwork, options = {}) => {
							requireOpenUpdate()
							if (isSignerOnlyNetwork(nextNetwork)) return 'signerOnly'
							const entryChanged = options.updateMetadata && getRpcEntryIdentityKey(installedNetwork) !== getRpcEntryIdentityKey(nextNetwork)
							if (!entryChanged && !getRpcNetworkChange(installedNetwork, nextNetwork).endpointChanged) return 'unchanged'
							refreshRequested = true
							services = getCurrent()
							try {
								current = replace(current, nextNetwork)
								installedNetwork = nextNetwork
								services = current
								replacement = 'replaced'
								return 'replaced'
							} catch (error) {
								replacement = 'failed'
								throw error
							}
						},
						requestRefresh: () => { requireOpenUpdate(); refreshRequested = true; if (replacement === 'unchanged') services = getCurrent() },
					})
					return { status: 'completed' as const, replacement, result, services, refreshRequested }
				} catch (error: unknown) {
					return { status: 'failed' as const, error, services, refreshRequested, replacement }
				} finally {
					updateOpen = false
				}
			})()
			// The workflow has settled and released its own ordering lock before observing its captured pair.
			if (completed.refreshRequested) {
				const outcome: SimulationServicesUpdateOutcome = completed.status === 'failed' ? { status: 'failed', error: completed.error, replacement: completed.replacement } : { status: 'completed', replacement: completed.replacement }
				try {
					await observe(completed.services, outcome)
				} catch (observerError) {
					// Refresh publication is a post-commit side effect. Report it separately without replacing the mutation's result or primary error.
					try {
						await reportObserverError(observerError)
					} catch (reportingError) {
						const errors = completed.status === 'failed' ? [completed.error, observerError, reportingError] : [observerError, reportingError]
						throw new AggregateError(errors, 'Simulation refresh and its error reporting failed')
					}
				}
			}
			if (completed.status === 'failed') throw completed.error
			return completed.result
		},
	}
}

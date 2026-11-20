import type { EthereumBlockHeader } from '../types/wire-types.js'
import { getRpcNetworkChange, getRpcEntryIdentityKey, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { EthereumJSONRpcRequestHandler, type RpcRequestLifecycleCallbacks } from './services/EthereumJSONRpcRequestHandler.js'
import { TokenPriceService } from './services/priceEstimator.js'

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
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	return new EthereumClientService(
		new EthereumJSONRpcRequestHandler(rpcNetwork.httpsRpc, true, rpcRequestLifecycleCallbacks),
		newBlockAttemptCallback,
		onErrorBlockCallback,
		rpcNetwork,
	)
}

export function createSimulationServices(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	tokenPriceCacheAge = 60000,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
): SimulationServices {
	const ethereum = createEthereumClientService(
		rpcNetwork,
		newBlockAttemptCallback,
		onErrorBlockCallback,
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
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
): SimulationServices {
	// Retire background polling; cleanup does not invalidate RPC methods used by an in-flight snapshot.
	currentServices.ethereum.cleanup()
	return createSimulationServices(
		rpcNetwork,
		newBlockAttemptCallback,
		onErrorBlockCallback,
		currentServices.tokenPriceService.cacheAge,
		rpcRequestLifecycleCallbacks,
	)
}

export type SimulationNetworkReconciliation = 'replaced' | 'unchanged' | 'signerOnly'

export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServices
	// Reconcile the installed endpoint; RPC-list edits can also request fresh metadata without mutating captured clients.
	readonly ensureNetwork: (rpcNetwork: RpcNetwork, options?: { readonly updateMetadata?: boolean }) => SimulationNetworkReconciliation
}

// The owner's getCurrent, passed to code that must act on the services installed at the moment it runs, never on services it captured before slow work, such as what the confirmation window is shown.
export type GetInstalledServices = SimulationServicesOwner['getCurrent']

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	return createSimulationServicesOwnerForServices(
		rpcNetwork,
		createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks),
		(current, nextRpc) => resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks),
	)
}

// The owner records the installed selection explicitly, so injected services need not spoof client metadata to participate in reconciliation.
export function createSimulationServicesOwnerForServices(initialNetwork: RpcEntry, initial: SimulationServices, replace: (current: SimulationServices, network: RpcEntry) => SimulationServices): SimulationServicesOwner {
	let current = initial
	let installedNetwork = initialNetwork
	return {
		getCurrent: () => current,
		ensureNetwork: (nextNetwork, options = {}) => {
			if (isSignerOnlyNetwork(nextNetwork)) return 'signerOnly'
			const entryChanged = options.updateMetadata && getRpcEntryIdentityKey(installedNetwork) !== getRpcEntryIdentityKey(nextNetwork)
			if (!entryChanged && !getRpcNetworkChange(installedNetwork, nextNetwork).endpointChanged) return 'unchanged'
			current = replace(current, nextNetwork)
			installedNetwork = nextNetwork
			return 'replaced'
		},
	}
}

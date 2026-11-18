import type { EthereumBlockHeader } from '../types/wire-types.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
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

export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServices
	// Reconcile against the installed endpoint; return true only when services were replaced. Signer-only selections retain the fallback.
	readonly ensureNetwork: (rpcNetwork: RpcNetwork) => boolean
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	return createSimulationServicesOwnerForServices(
		createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks),
		(current, nextRpc) => resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks),
	)
}

// The same owner can manage real clients or injected services, with one reconciliation policy and no separate endpoint bookkeeping.
export function createSimulationServicesOwnerForServices(initial: SimulationServices, replace: (current: SimulationServices, network: RpcEntry) => SimulationServices): SimulationServicesOwner {
	let current = initial
	return {
		getCurrent: () => current,
		ensureNetwork: (nextNetwork) => {
			if (nextNetwork.httpsRpc === undefined || !getRpcNetworkChange(current.ethereum.getRpcEntry(), nextNetwork).endpointChanged) return false
			current = replace(current, nextNetwork)
			return true
		},
	}
}

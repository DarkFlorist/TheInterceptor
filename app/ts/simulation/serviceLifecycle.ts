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
	readonly reset: (rpcNetwork: RpcEntry) => SimulationServices
	// Reconcile a selected network with the installed endpoint, retaining fallback services for signer-only selections.
	readonly ensureNetwork: (rpcNetwork: RpcNetwork) => void
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	let current = createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks)
	let installedNetwork = rpcNetwork
	const reset = (nextRpc: RpcEntry): SimulationServices => {
		current = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks)
		installedNetwork = nextRpc
		return current
	}
	return {
		getCurrent: () => current,
		reset,
		ensureNetwork: (nextNetwork: RpcNetwork): void => {
			if (nextNetwork.httpsRpc !== undefined && getRpcNetworkChange(installedNetwork, nextNetwork).endpointChanged) reset(nextNetwork)
		},
	}
}

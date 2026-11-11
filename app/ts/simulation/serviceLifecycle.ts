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

export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServices
	readonly reset: (rpcNetwork: RpcEntry) => SimulationServices
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	// Advanced by every install. Each client compares the generation it was installed at, so installing a replacement makes every earlier client report itself replaced.
	let installedGeneration = 0
	const livenessAt = (generation: number): ClientLiveness => () => generation === installedGeneration
	let current = createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(installedGeneration), 60000, rpcRequestLifecycleCallbacks)
	return {
		getCurrent: () => current,
		reset: (nextRpc: RpcEntry): SimulationServices => {
			// The generation advances only once the replacement exists, so a reset that fails to build it leaves the installed services current.
			const nextGeneration = installedGeneration + 1
			const next = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, livenessAt(nextGeneration), rpcRequestLifecycleCallbacks)
			installedGeneration = nextGeneration
			current = next
			return current
		},
	}
}

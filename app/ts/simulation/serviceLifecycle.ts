import type { EthereumBlockHeader } from '../types/wire-types.js'
import type { RpcEntry } from '../types/rpc.js'
import { EthereumClientService } from './services/EthereumClientService.js'
import { EthereumJSONRpcRequestHandler, type RpcRequestLifecycleCallbacks } from './services/EthereumJSONRpcRequestHandler.js'
import { TokenPriceService } from './services/priceEstimator.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'

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
	readonly getCurrent: () => SimulationServices | undefined
	readonly requireCurrent: () => SimulationServices
	readonly reset: (rpcNetwork: RpcEntry) => SimulationServices
	readonly recover: (rpcNetwork: RpcEntry) => SimulationServices
	readonly clear: () => void
}

export const isCurrentSimulationService = (owner: SimulationServicesOwner | undefined, ethereumClientService: EthereumClientService) => {
	return owner?.getCurrent()?.ethereum === ethereumClientService
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read requireCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry | undefined,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
	// Runs after services are installed for a network: every recover() (including when services stayed installed through an outage in which only the RPC configuration was unreadable) and every reset() to another network. Work deferred for a network (such as Safe signer replies deferred for their signing chain) must be replayed once that network's services are back. The callback must be idempotent.
	onServicesInstalled: () => void = () => undefined,
) {
	let current = rpcNetwork === undefined ? undefined : createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks)
	return {
		getCurrent: () => current,
		requireCurrent: () => {
			if (current === undefined) throw createRpcConfigurationUnavailableError()
			return current
		},
		reset: (nextRpc: RpcEntry): SimulationServices => {
			if (current === undefined) throw createRpcConfigurationUnavailableError()
			current = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks)
			onServicesInstalled()
			return current
		},
		recover: (nextRpc: RpcEntry): SimulationServices => {
			current = current === undefined
				? createSimulationServices(nextRpc, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks)
				: resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks)
			onServicesInstalled()
			return current
		},
		clear: () => {
			current?.ethereum.cleanup()
			current = undefined
		},
	}
}

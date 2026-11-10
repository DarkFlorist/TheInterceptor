import type { EthereumBlockHeader } from '../types/wire-types.js'
import type { RpcEntry } from '../types/rpc.js'
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
}

// For each client an owner installed, that owner. Message handlers hand refreshes a service pair but not the owner, so this lets the holder of a pair ask the owner that installed it whether it is still current; a WeakMap, so replaced clients can still be collected.
const installingOwners = new WeakMap<EthereumClientService, Pick<SimulationServicesOwner, 'getCurrent'>>()

// Every install records its owner: the owner below on creation and on each reset, and any test owner standing in for one.
export const recordInstalledServices = (services: SimulationServices, owner: Pick<SimulationServicesOwner, 'getCurrent'>) => { installingOwners.set(services.ethereum, owner) }

// Whether the owner that installed this client still has it installed. A client no owner installed, such as a temporary lookup client, is not replaced by anything.
export const simulationServicesAreCurrent = (ethereum: EthereumClientService) => {
	const owner = installingOwners.get(ethereum)
	return owner === undefined || owner.getCurrent().ethereum === ethereum
}

// One owner publishes installed services. Returned pairs are snapshots for an operation; independent message handlers must read getCurrent() when their work starts.
export function createSimulationServicesOwner(
	rpcNetwork: RpcEntry,
	newBlockAttemptCallback: NewBlockAttemptCallback,
	onErrorBlockCallback: OnErrorBlockCallback,
	rpcRequestLifecycleCallbacks: RpcRequestLifecycleCallbacks = {},
) {
	let current = createSimulationServices(rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback, 60000, rpcRequestLifecycleCallbacks)
	const owner = {
		getCurrent: () => current,
		reset: (nextRpc: RpcEntry): SimulationServices => {
			current = resetSimulationServices(current, nextRpc, newBlockAttemptCallback, onErrorBlockCallback, rpcRequestLifecycleCallbacks)
			recordInstalledServices(current, owner)
			return current
		},
	}
	recordInstalledServices(current, owner)
	return owner
}

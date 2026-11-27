import { createGnosisSafeAppsSimulationMetadataReader, type GnosisSafeAppsSimulationMetadataReader } from '../gnosisSafe/gnosisSafeAppsSimulation.js'
import { createSimulationServices, resetSimulationServices, type SimulationServices, type NewBlockAttemptCallback, type OnErrorBlockCallback } from '../simulation/serviceLifecycle.js'
import type { RpcRequestLifecycleCallbacks } from '../simulation/services/EthereumJSONRpcRequestHandler.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'
import { getRpcNetworkChange, getRpcEntryIdentityKey, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'

// Background composition owns installed client snapshots and domain-specific request services; neutral simulation client construction stays below this layer.
export type SimulationServicesSnapshot = SimulationServices & { readonly gnosisSafeAppsSimulationMetadata: GnosisSafeAppsSimulationMetadataReader }

const captureSimulationServices = (services: SimulationServices): SimulationServicesSnapshot => ({ ethereum: services.ethereum, tokenPriceService: services.tokenPriceService, gnosisSafeAppsSimulationMetadata: createGnosisSafeAppsSimulationMetadataReader(services.ethereum) })

export type SimulationNetworkReconciliation = 'replaced' | 'unchanged' | 'signerOnly'

export type SimulationServicesOwner = {
	readonly getCurrent: () => SimulationServicesSnapshot
	// Reconcile the installed endpoint; RPC-list edits can also request fresh metadata without mutating captured clients.
	readonly ensureNetwork: (rpcNetwork: RpcNetwork, options?: { readonly updateMetadata?: boolean }) => SimulationNetworkReconciliation
}

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
	let current = captureSimulationServices(initial)
	let installedNetwork = initialNetwork
	return {
		getCurrent: () => current,
		ensureNetwork: (nextNetwork, options = {}) => {
			if (isSignerOnlyNetwork(nextNetwork)) return 'signerOnly'
			const entryChanged = options.updateMetadata && getRpcEntryIdentityKey(installedNetwork) !== getRpcEntryIdentityKey(nextNetwork)
			if (!entryChanged && !getRpcNetworkChange(installedNetwork, nextNetwork).endpointChanged) return 'unchanged'
			current = captureSimulationServices(replace(current, nextNetwork))
			installedNetwork = nextNetwork
			return 'replaced'
		},
	}
}

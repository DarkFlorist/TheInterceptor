import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcConfigurationState } from './rpcConfigurationStorage.js'
import { getRpcConfigurationState, selectPrimaryRpc, setRpcConfiguration, setRpcList } from './rpcConfigurationStorage.js'
import type { RpcEntries, RpcEntry, RpcNetwork } from '../types/rpc.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import { resolveRpcServicesTarget } from './rpcConfigurationAvailability.js'
import { assertNever } from '../utils/typescript.js'

type RpcListTransitionMode = 'edit' | 'restore-defaults'

// The simulation-services change a stored RPC configuration needs. It is returned as data and applied by applyRpcServicesChange after the write is committed, as a step that can fail on its own, so a failed service change never skips the reconciliation of that write.
export type RpcServicesChange =
	| { readonly kind: 'none' }
	| { readonly kind: 'clear' }
	| { readonly kind: 'recover', readonly rpcNetwork: RpcEntry }
	// Running services are required (they may have been cleared since the write) and moved to `rpcNetwork` when there is one.
	| { readonly kind: 'keep-running', readonly rpcNetwork: RpcEntry | undefined }

export function applyRpcServicesChange(simulationServicesOwner: SimulationServicesOwner, change: RpcServicesChange) {
	switch (change.kind) {
		case 'none': return
		case 'clear': return simulationServicesOwner.clear()
		case 'recover': {
			simulationServicesOwner.recover(change.rpcNetwork)
			return
		}
		case 'keep-running': {
			if (simulationServicesOwner.getCurrent() === undefined) throw createRpcConfigurationUnavailableError()
			if (change.rpcNetwork !== undefined) simulationServicesOwner.reset(change.rpcNetwork)
			return
		}
		default: return assertNever(change)
	}
}

export type RpcListTransitionResult = {
	readonly activeRpcNetwork: RpcNetwork
	readonly rpcConfigurationAvailable: boolean
	readonly publishRecovery: boolean
	readonly forceChainChanged: boolean
	readonly servicesChange: RpcServicesChange
}

function selectRestoredActiveNetwork(previousConfiguration: RpcConfigurationState, rpcEntries: readonly RpcEntry[]) {
	if ('activeRpcNetwork' in previousConfiguration && previousConfiguration.activeRpcNetwork !== undefined) return previousConfiguration.activeRpcNetwork
	return selectPrimaryRpc(rpcEntries)
}

// This single RPC-list transition boundary owns persistence; it returns once the write is committed, with the services change the caller applies (applyRpcServicesChange), the RPC status to publish and whether to publish the recovery.
export async function transitionRpcList(
	simulationServicesOwner: SimulationServicesOwner,
	rpcEntries: readonly RpcEntry[],
	mode: RpcListTransitionMode,
): Promise<RpcListTransitionResult> {
	const previousConfiguration = await getRpcConfigurationState()
	if (mode === 'restore-defaults') {
		const activeRpcNetwork = selectRestoredActiveNetwork(previousConfiguration, rpcEntries)
		if (activeRpcNetwork === undefined) throw new Error('Bundled RPC configuration is empty.')
		if (previousConfiguration.status === 'ready') {
			await setRpcList(rpcEntries)
			const shouldRecoverServices = activeRpcNetwork.httpsRpc !== undefined && simulationServicesOwner.getCurrent() === undefined
			return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: shouldRecoverServices, forceChainChanged: false, servicesChange: shouldRecoverServices ? { kind: 'recover', rpcNetwork: activeRpcNetwork } : { kind: 'none' } }
		}
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		const previousActiveRpcNetwork = 'activeRpcNetwork' in previousConfiguration ? previousConfiguration.activeRpcNetwork : undefined
		return {
			activeRpcNetwork,
			rpcConfigurationAvailable: true,
			publishRecovery: previousConfiguration.status === 'unavailable',
			forceChainChanged: previousActiveRpcNetwork === undefined,
			servicesChange: activeRpcNetwork.httpsRpc === undefined ? { kind: 'clear' } : { kind: 'recover', rpcNetwork: activeRpcNetwork },
		}
	}

	if (previousConfiguration.status === 'unavailable') {
		simulationServicesOwner.clear()
		const activeRpcNetwork = selectPrimaryRpc(rpcEntries)
		if (previousConfiguration.reason !== 'empty' || activeRpcNetwork === undefined) throw createRpcConfigurationUnavailableError()
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: true, forceChainChanged: false, servicesChange: { kind: 'recover', rpcNetwork: activeRpcNetwork } }
	}

	const activeRpcNetwork = previousConfiguration.activeRpcNetwork
	if (activeRpcNetwork.httpsRpc === undefined && simulationServicesOwner.getCurrent() === undefined) {
		await setRpcList(rpcEntries)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false, servicesChange: { kind: 'none' } }
	}
	if (simulationServicesOwner.getCurrent() === undefined) throw createRpcConfigurationUnavailableError()
	await setRpcList(rpcEntries)
	if (rpcEntries.length === 0) return { activeRpcNetwork, rpcConfigurationAvailable: activeRpcNetwork.httpsRpc === undefined, publishRecovery: false, forceChainChanged: false, servicesChange: { kind: 'clear' } }
	const primary = rpcEntries.find((rpc) => rpc.chainId === activeRpcNetwork.chainId && rpc.primary)
	return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false, servicesChange: { kind: 'keep-running', rpcNetwork: primary } }
}

// Retry re-reads the stored configuration without writing it. Services pause unless it is ready; a ready configuration resumes them only when it has an RPC endpoint to serve. The services change is returned for the caller to apply (applyRpcServicesChange).
export async function readRpcConfigurationRetry(): Promise<{ readonly retriedConfiguration: { readonly rpcEntries: RpcEntries } | undefined, readonly servicesChange: RpcServicesChange }> {
	const configuration = await getRpcConfigurationState()
	if (configuration.status !== 'ready') return { retriedConfiguration: undefined, servicesChange: { kind: 'clear' } }
	const rpcNetwork = resolveRpcServicesTarget(configuration)
	return { retriedConfiguration: { rpcEntries: configuration.rpcEntries }, servicesChange: rpcNetwork === undefined ? { kind: 'clear' } : { kind: 'recover', rpcNetwork } }
}

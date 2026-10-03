import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { getRpcConfigurationState, setRpcConfiguration, setRpcList } from './storageVariables.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'

type RpcListTransitionMode = 'edit' | 'restore-defaults'

export type RpcListTransitionResult = {
	readonly activeRpcNetwork: RpcNetwork
	readonly rpcConfigurationAvailable: boolean
	readonly publishRecovery: boolean
	readonly forceChainChanged: boolean
}

function selectRestoredActiveNetwork(previousConfiguration: RpcConfigurationState, rpcEntries: readonly RpcEntry[]) {
	if ('activeRpcNetwork' in previousConfiguration && previousConfiguration.activeRpcNetwork !== undefined) return previousConfiguration.activeRpcNetwork
	return rpcEntries.find((rpc) => rpc.primary) ?? rpcEntries[0]
}

// This single RPC-list transition boundary owns persistence and service recovery; callers only validate input and publish its result.
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
			if (shouldRecoverServices) simulationServicesOwner.recover(activeRpcNetwork)
			return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: shouldRecoverServices, forceChainChanged: false }
		}
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		if (activeRpcNetwork.httpsRpc === undefined) simulationServicesOwner.clear()
		else simulationServicesOwner.recover(activeRpcNetwork)
		const previousActiveRpcNetwork = 'activeRpcNetwork' in previousConfiguration ? previousConfiguration.activeRpcNetwork : undefined
		return {
			activeRpcNetwork,
			rpcConfigurationAvailable: true,
			publishRecovery: previousConfiguration.status === 'unavailable',
			forceChainChanged: previousActiveRpcNetwork === undefined,
		}
	}

	if (previousConfiguration.status === 'unavailable') {
		simulationServicesOwner.clear()
		const activeRpcNetwork = rpcEntries.find((rpc) => rpc.primary) ?? rpcEntries[0]
		if (previousConfiguration.reason !== 'empty' || activeRpcNetwork === undefined) throw new Error('RPC configuration is unavailable. Restore it before editing RPC connections.')
		await setRpcConfiguration(rpcEntries, activeRpcNetwork)
		simulationServicesOwner.recover(activeRpcNetwork)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: true, forceChainChanged: false }
	}

	const activeRpcNetwork = previousConfiguration.activeRpcNetwork
	if (activeRpcNetwork.httpsRpc === undefined && simulationServicesOwner.getCurrent() === undefined) {
		await setRpcList(rpcEntries)
		return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false }
	}
	if (simulationServicesOwner.getCurrent() === undefined) throw new Error('RPC configuration is unavailable. Restore it before editing RPC connections.')
	await setRpcList(rpcEntries)
	if (rpcEntries.length === 0) {
		simulationServicesOwner.clear()
		return { activeRpcNetwork, rpcConfigurationAvailable: activeRpcNetwork.httpsRpc === undefined, publishRecovery: false, forceChainChanged: false }
	}
	if (simulationServicesOwner.getCurrent() === undefined) throw new Error('RPC configuration became unavailable while saving RPC connections.')
	const primary = rpcEntries.find((rpc) => rpc.chainId === activeRpcNetwork.chainId && rpc.primary)
	if (primary !== undefined) simulationServicesOwner.reset(primary)
	return { activeRpcNetwork, rpcConfigurationAvailable: true, publishRecovery: false, forceChainChanged: false }
}

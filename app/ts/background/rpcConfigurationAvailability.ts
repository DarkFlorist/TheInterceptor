import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcEntry } from '../types/rpc.js'
import type { RpcConfigurationState } from './storageVariables.js'

export function rpcConfigurationIsReady(rpcConfiguration: RpcConfigurationState): rpcConfiguration is Extract<RpcConfigurationState, { status: 'ready' }> {
	return rpcConfiguration.status === 'ready'
}

export function resolveRpcServicesTarget(configuration: RpcConfigurationState): RpcEntry | undefined {
	if (!rpcConfigurationIsReady(configuration)) return undefined
	if (configuration.activeRpcNetwork.httpsRpc !== undefined) return configuration.activeRpcNetwork
	return configuration.rpcEntries.find((rpc) => rpc.chainId === configuration.activeRpcNetwork.chainId && rpc.primary)
		?? configuration.rpcEntries.find((rpc) => rpc.primary)
		?? configuration.rpcEntries[0]
}

export function rpcServicesAreOptional(rpcConfiguration: RpcConfigurationState) {
	return rpcConfigurationIsReady(rpcConfiguration) && rpcConfiguration.activeRpcNetwork.httpsRpc === undefined
}

export function rpcServicesAreAvailable(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner) {
	return getRpcServicesAtAdmission(rpcConfiguration, simulationServicesOwner) !== undefined
}

// This is the single admission point for work that must keep using one installed service pair even when settings replace or clear the live owner during an await.
export function getRpcServicesAtAdmission(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner): SimulationServices | undefined {
	if (!rpcConfigurationIsReady(rpcConfiguration)) return undefined
	return simulationServicesOwner.getCurrent()
}

export function rpcConfigurationIsUsable(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner) {
	return rpcServicesAreOptional(rpcConfiguration) || rpcServicesAreAvailable(rpcConfiguration, simulationServicesOwner)
}

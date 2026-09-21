import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcConfigurationState } from './storageVariables.js'

export function rpcServicesAreOptional(rpcConfiguration: RpcConfigurationState) {
	return rpcConfiguration.status === 'ready' && rpcConfiguration.activeRpcNetwork.httpsRpc === undefined
}

export function applyRpcConfigurationToServiceLifecycle(simulationServicesOwner: SimulationServicesOwner, rpcConfiguration: RpcConfigurationState) {
	if (rpcConfiguration.status === 'unavailable') simulationServicesOwner.clear()
}

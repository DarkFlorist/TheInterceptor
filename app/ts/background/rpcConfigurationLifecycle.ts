import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { METAMASK_ERROR_PROVIDER_DISCONNECTED } from '../utils/constants.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import type { RpcConfigurationState } from './storageVariables.js'

export const RPC_CONFIGURATION_UNAVAILABLE_ERROR = {
	code: METAMASK_ERROR_PROVIDER_DISCONNECTED,
	message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
}

export function rpcServicesAreOptional(rpcConfiguration: RpcConfigurationState) {
	return rpcConfiguration.status === 'ready' && rpcConfiguration.activeRpcNetwork.httpsRpc === undefined
}

export function replyIfRpcConfigurationIsUnavailable(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest | undefined, rpcConfiguration: RpcConfigurationState) {
	if (request === undefined || rpcServicesAreOptional(rpcConfiguration)) return false
	if (rpcConfiguration.status === 'ready' && simulationServicesOwner.isAvailable()) return false
	replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...request,
		error: RPC_CONFIGURATION_UNAVAILABLE_ERROR,
	})
	return true
}

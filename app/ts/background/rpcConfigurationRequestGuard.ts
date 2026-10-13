import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { rpcConfigurationIsUsable } from './rpcConfigurationAvailability.js'
import type { RpcConfigurationState } from './storageVariables.js'

export function replyIfRpcConfigurationIsUnavailable(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest | undefined, rpcConfiguration: RpcConfigurationState) {
	if (request === undefined || rpcConfigurationIsUsable(rpcConfiguration, simulationServicesOwner)) return false
	replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...request,
		error: RPC_CONFIGURATION_UNAVAILABLE_ERROR,
	})
	return true
}

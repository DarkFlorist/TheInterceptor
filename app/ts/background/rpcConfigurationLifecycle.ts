import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { METAMASK_ERROR_PROVIDER_DISCONNECTED } from '../utils/constants.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import type { RpcConfigurationState } from './storageVariables.js'
import type { RpcEntry, RpcNetwork } from '../types/rpc.js'

export const RPC_CONFIGURATION_UNAVAILABLE_ERROR = {
	code: METAMASK_ERROR_PROVIDER_DISCONNECTED,
	message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
}

const RPC_CONFIGURATION_UNAVAILABLE_NETWORK: RpcNetwork = {
	httpsRpc: undefined,
	chainId: 1n,
	name: 'RPC configuration unavailable',
	currencyName: 'Ether?',
	currencyTicker: 'ETH?',
	primary: false,
	minimized: true,
}

export function getRpcNetworkForSettings(rpcConfiguration: RpcConfigurationState) {
	return 'activeRpcNetwork' in rpcConfiguration && rpcConfiguration.activeRpcNetwork !== undefined
		? rpcConfiguration.activeRpcNetwork
		: RPC_CONFIGURATION_UNAVAILABLE_NETWORK
}

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
	return rpcConfigurationIsReady(rpcConfiguration) && simulationServicesOwner.isAvailable()
}

export function rpcConfigurationIsUsable(rpcConfiguration: RpcConfigurationState, simulationServicesOwner: SimulationServicesOwner) {
	return rpcServicesAreOptional(rpcConfiguration) || rpcServicesAreAvailable(rpcConfiguration, simulationServicesOwner)
}

export function replyIfRpcConfigurationIsUnavailable(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest | undefined, rpcConfiguration: RpcConfigurationState) {
	if (request === undefined || rpcConfigurationIsUsable(rpcConfiguration, simulationServicesOwner)) return false
	replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...request,
		error: RPC_CONFIGURATION_UNAVAILABLE_ERROR,
	})
	return true
}

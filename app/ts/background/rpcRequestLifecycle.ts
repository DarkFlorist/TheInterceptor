import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../utils/requests.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { switchEthereumChain } from './simulationModeHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'

// Lifecycle operations deliberately act on the installed services. They expose no provider that ordinary RPC handlers could accidentally use instead of their admitted pair.
export type RpcRequestLifecycle = {
	readonly wakeCurrentRpc: () => Promise<void>
	readonly switchActiveNetwork: (connections: WebsiteTabConnections, parameters: Extract<EthereumJsonRpcRequest, { readonly method: 'wallet_switchEthereumChain' }>, request: InterceptedRequest, simulationMode: boolean, website: Website) => Promise<RPCReply>
}

export function createRpcRequestLifecycle(owner: SimulationServicesOwner, publishRpcConnectionStatus: PublishRpcConnectionStatus): RpcRequestLifecycle {
	return {
		wakeCurrentRpc: async () => {
			const ethereum = owner.getCurrent()?.ethereum
			if (ethereum !== undefined) await makeSureInterceptorIsNotSleeping(ethereum, publishRpcConnectionStatus)
		},
		switchActiveNetwork: async (connections, parameters, request, simulationMode, website) => await switchEthereumChain(owner, connections, parameters, request, simulationMode, website),
	}
}

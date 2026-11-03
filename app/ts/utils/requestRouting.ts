import type { RpcNetwork } from '../types/rpc.js'

export type RequestRoutingState = {
	readonly simulationMode: boolean
	readonly signerAvailable: boolean
}

// Signing mode with an available signer lets the signer answer requests the Interceptor does not handle itself.
export function isForwardingRequestsToSigner({ simulationMode, signerAvailable }: RequestRoutingState) {
	return !simulationMode && signerAvailable
}

// Without an Interceptor RPC, signing mode passes requests straight to the signer; simulation mode (or a missing signer) still intercepts them.
export function isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, routingState: RequestRoutingState) {
	return rpcNetwork.httpsRpc === undefined && isForwardingRequestsToSigner(routingState)
}

// Describe a network without an Interceptor RPC to match its request routing; signerAvailable is undefined when the caller cannot tell whether the requesting website has a signer.
export function getNetworkWithoutRpcWarning(rpcNetwork: Pick<RpcNetwork, 'httpsRpc' | 'name'>, simulationMode: boolean, signerAvailable: boolean | undefined) {
	if (rpcNetwork.httpsRpc !== undefined) return undefined
	const mayBypassInterceptor = isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork, { simulationMode, signerAvailable: signerAvailable ?? true })
	if (!mayBypassInterceptor) return `${ rpcNetwork.name } has no configured RPC. Select or configure an RPC for ${ rpcNetwork.name }.`
	if (signerAvailable === undefined) return `${ rpcNetwork.name } has no configured RPC. Until one is configured, the Interceptor cannot simulate requests on ${ rpcNetwork.name }; in signing mode with a connected wallet they go to the wallet directly.`
	return `${ rpcNetwork.name } is not a supported network. The Interceptor is disabled while you are using ${ rpcNetwork.name }.`
}

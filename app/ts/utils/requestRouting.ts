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

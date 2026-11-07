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

type KnownSignerAvailability = 'available' | 'missing'

// 'unknown' is for callers that cannot tell whether the requesting website has a signer, such as pages not tied to a website's tab.
export type SignerAvailability = KnownSignerAvailability | 'unknown'

type KnownSignerNetworkWithoutRpcWarningState = { readonly kind: 'none' } | { readonly kind: 'noRpcNeedsConfig' } | { readonly kind: 'noRpcBypassToSigner' }

export type NetworkWithoutRpcWarningState = KnownSignerNetworkWithoutRpcWarningState | { readonly kind: 'noRpcMayBypass' }

export function getNetworkWithoutRpcWarningState(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, simulationMode: boolean, signerAvailability: KnownSignerAvailability): KnownSignerNetworkWithoutRpcWarningState
export function getNetworkWithoutRpcWarningState(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, simulationMode: boolean, signerAvailability: SignerAvailability): NetworkWithoutRpcWarningState
export function getNetworkWithoutRpcWarningState(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, simulationMode: boolean, signerAvailability: SignerAvailability): NetworkWithoutRpcWarningState {
	if (rpcNetwork.httpsRpc !== undefined) return { kind: 'none' }
	// An unknown signer cannot be ruled out, so requests may bypass the Interceptor wherever an available signer would receive them.
	if (signerAvailability === 'unknown') return { kind: isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork, { simulationMode, signerAvailable: true }) ? 'noRpcMayBypass' : 'noRpcNeedsConfig' }
	return { kind: isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork, { simulationMode, signerAvailable: signerAvailability === 'available' }) ? 'noRpcBypassToSigner' : 'noRpcNeedsConfig' }
}

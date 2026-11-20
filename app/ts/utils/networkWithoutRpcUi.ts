import type { RpcNetwork } from '../types/rpc.js'
import { getRequestRoutingState, isBypassingInterceptorOnNetworkWithoutRpc } from './requestRouting.js'
import { assertNever } from './typescript.js'

// 'unknown' is for callers that cannot tell whether the requesting website has a signer, such as pages not tied to a website's tab.
export type SignerAvailability = 'available' | 'missing' | 'unknown'

export type NetworkWithoutRpcWarning = { readonly kind: 'noRpcNeedsConfig' } | { readonly kind: 'noRpcBypassToSigner' } | { readonly kind: 'noRpcMayBypass' }

export type NetworkWithoutRpcWarningState = { readonly kind: 'none' } | NetworkWithoutRpcWarning

// Explains the decision request forwarding makes with the same rule and routing state; activeAddressSignsDirectly is whether the active address signs with a Ledger or AirGap wallet.
export function getNetworkWithoutRpcWarningState(rpcNetwork: Pick<RpcNetwork, 'httpsRpc'>, simulationMode: boolean, signerAvailability: SignerAvailability, activeAddressSignsDirectly: boolean): NetworkWithoutRpcWarningState {
	if (rpcNetwork.httpsRpc !== undefined) return { kind: 'none' }
	// An unknown signer cannot be ruled out, so requests may bypass the Interceptor wherever an available signer would receive them.
	const routingState = getRequestRoutingState(simulationMode, signerAvailability !== 'missing', activeAddressSignsDirectly)
	if (!isBypassingInterceptorOnNetworkWithoutRpc(rpcNetwork, routingState)) return { kind: 'noRpcNeedsConfig' }
	return { kind: signerAvailability === 'unknown' ? 'noRpcMayBypass' : 'noRpcBypassToSigner' }
}

// The single source of this wording for the popup banners and the toolbar icon tooltip, so it must stay importable from the background without pulling in components.
export function getNetworkWithoutRpcWarningText(networkName: string, warning: NetworkWithoutRpcWarning) {
	switch (warning.kind) {
		case 'noRpcNeedsConfig': return `${ networkName } has no configured RPC. Select or configure an RPC for ${ networkName }.`
		case 'noRpcMayBypass': return `${ networkName } has no configured RPC. Until one is configured, the Interceptor cannot simulate requests on ${ networkName }; in signing mode with a connected wallet they go to the wallet directly.`
		case 'noRpcBypassToSigner': return `${ networkName } is not a supported network. The Interceptor is disabled while you are using ${ networkName }.`
		default: return assertNever(warning)
	}
}

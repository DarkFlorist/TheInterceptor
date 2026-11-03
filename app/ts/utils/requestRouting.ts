import type { RpcNetwork } from '../types/rpc.js'

// Whether the background forwards a website's requests to its wallet: only in signing mode, and only when the page has a wallet to forward to.
export function isForwardingRequestsToSigner(simulationMode: boolean, signerAvailable: boolean) {
	return !simulationMode && signerAvailable
}

// Whether requests skip the Interceptor and go straight to the wallet because the selected network has no RPC to simulate them with. In simulation mode, or without a wallet, requests on such a network are still intercepted.
export function isBypassingInterceptorOnNetworkWithoutRpc(forwardingRequestsToSigner: boolean, rpcNetwork: RpcNetwork) {
	return forwardingRequestsToSigner && rpcNetwork.httpsRpc === undefined
}

import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'

// The background builds the request it forwards to the wallet and the confirmation popup describes that request, so both read these rules from here.
type SignerFacingTransactionSource = {
	readonly simulationMode: boolean
	readonly originalRequestParameters: OriginalSendRequestParameters
}

// The kind of the pending transaction's Safe flow, if any; callers map their Safe flow to it so this shared rule stays independent of the Safe domain.
type SafeTransactionFlowKind = 'directExecution' | 'proposal' | undefined

// The nonce the wallet will sign: the simulated one in simulation mode, one the wallet picks for requests that omitted it, or exactly the one the website requested.
export type SignerNonce = { readonly kind: 'simulated' } | { readonly kind: 'wallet-selected' } | { readonly kind: 'website-requested', readonly nonce: bigint }

// Simulation mode only adds the prepared transaction to the local simulation, and a Safe proposal sends the wallet typed data instead of this request.
export function isTransactionRequestForwardedToWallet(pending: SignerFacingTransactionSource, safeFlowKind: SafeTransactionFlowKind) {
	return !pending.simulationMode && safeFlowKind !== 'proposal'
}

// The simulator repairs nonces against the latest block only for its preview, so its nonce is never forwarded: an omitted nonce stays wallet-selected because the wallet can see its own pending transactions, and a nonce the website supplied is forwarded unchanged so its ordering and replay protection hold. Raw transactions are already signed, and requests that never reach the wallet keep the simulated nonce.
export function getSignerNonce(pending: SignerFacingTransactionSource, safeFlowKind: SafeTransactionFlowKind): SignerNonce {
	if (!isTransactionRequestForwardedToWallet(pending, safeFlowKind) || pending.originalRequestParameters.method !== 'eth_sendTransaction') return { kind: 'simulated' }
	const websiteNonce = pending.originalRequestParameters.params[0].nonce
	return websiteNonce === undefined ? { kind: 'wallet-selected' } : { kind: 'website-requested', nonce: websiteNonce }
}

// How the background settles a forwarded signer request whose outcome it consumes itself instead of returning it on the page's signer_reply request.
export type BackgroundSettlementOfForwardedRequest = 'confirmationFlow' | 'watchAssetQueue'

// This module alone owns which forwarded methods are settled by background workflows. The wire reply carries the resulting signer-reply mode to the provider.
export const FORWARDED_METHODS_SETTLED_BY_BACKGROUND: ReadonlyMap<string, BackgroundSettlementOfForwardedRequest> = new Map([
	['personal_sign', 'confirmationFlow'],
	['eth_signTypedData', 'confirmationFlow'],
	['eth_signTypedData_v1', 'confirmationFlow'],
	['eth_signTypedData_v2', 'confirmationFlow'],
	['eth_signTypedData_v3', 'confirmationFlow'],
	['eth_signTypedData_v4', 'confirmationFlow'],
	['eth_sendRawTransaction', 'confirmationFlow'],
	['eth_sendTransaction', 'confirmationFlow'],
	['wallet_watchAsset', 'watchAssetQueue'],
])

export function getForwardedSignerReplyMode(method: string): 'notify' | 'request' {
	return FORWARDED_METHODS_SETTLED_BY_BACKGROUND.has(method) ? 'notify' : 'request'
}

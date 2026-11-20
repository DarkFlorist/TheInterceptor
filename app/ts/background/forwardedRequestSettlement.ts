// How the background settles a forwarded signer request whose outcome it consumes itself instead of returning it on the page's signer_reply request.
export type BackgroundSettlementOfForwardedRequest = 'confirmationFlow' | 'watchAssetQueue'

// Forwarded methods whose signer_reply the background settles itself and answers with doNotReply: signing requests resolve through the confirmation flow and wallet_watchAsset through the watch-asset queue. For every other forwarded method the inpage provider waits for an answer on its signer_reply request, so signerReply always answers it: with the signer's reply or error, or with signerConnectionReplacedError when the reply arrives over a connection that has since been replaced. The injected inpage provider is a classic script that cannot import this module, so app/inpage/ts/inpage.ts repeats these method names in its own FORWARDED_METHODS_SETTLED_BY_BACKGROUND, and test/tests/forwardedMethodsSettledByBackground.test.ts fails when the two lists drift apart.
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

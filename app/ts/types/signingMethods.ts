import * as funtypes from 'funtypes'

/** The persisted direct-request method schema is also the direct backend's capability set. */
export const DirectSigningMethod = funtypes.Union(funtypes.Literal('eth_sendTransaction'), funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData_v4'))
export const BrowserSigningMethod = funtypes.Union(DirectSigningMethod, funtypes.Literal('eth_sendRawTransaction'), funtypes.Literal('eth_sign'), funtypes.Literal('eth_signTypedData'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('wallet_sendCalls'))

/** Unknown eth_sign variants still require account checks and fail closed on direct wallets. */
export function isSigningOperation(method: string) {
	return BrowserSigningMethod.test(method) || method.startsWith('eth_sign')
}

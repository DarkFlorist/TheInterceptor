import type { SendRawTransactionParams, SendTransactionParams } from './JsonRpc-types.js'
import type { SignMessageParams } from './jsonRpc-signing-types.js'
import type { SafeMessageReview } from './safeReview.js'
import type { InterceptedRequest } from '../utils/requests.js'

// Internal confirmation requests describe the signing operation, independently of the frontend that admitted it.
export type TransactionConfirmationRequest = {
	readonly kind: 'transaction'
	readonly parameters: SendTransactionParams | SendRawTransactionParams
	readonly safeTransaction?: { readonly operation: 0 | 1, readonly messageReview?: SafeMessageReview }
}
export type MessageConfirmationRequest = {
	readonly kind: 'message'
	readonly parameters: SignMessageParams
	readonly review?: SafeMessageReview
}
export type ConfirmationRequest = TransactionConfirmationRequest | MessageConfirmationRequest
export type RpcRequestContext = { readonly request: InterceptedRequest, readonly confirmation?: ConfirmationRequest }

import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'

// Combine current dialog edits with the reviewed sender at confirmation time; stored requests retain omitted senders for account changes.
export function getConfirmationSignerRequest(pending: PendingTransactionOrSignableMessage): OriginalSendRequestParameters | SignMessageParams {
	const request = pending.originalRequestParameters
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || request.method !== 'eth_sendTransaction') return request
	return { ...request, params: [{ ...request.params[0], from: request.params[0].from ?? pending.transactionToSimulate.transaction.from }] }
}

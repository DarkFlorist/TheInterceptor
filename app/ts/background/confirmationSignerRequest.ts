import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'

// Combine current dialog edits with the reviewed sender at confirmation time; stored requests retain omitted senders for account changes.
export function getConfirmationSignerRequest(pending: PendingTransactionOrSignableMessage): OriginalSendRequestParameters | SignMessageParams {
	const editableRequest = pending.originalRequestParameters
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || editableRequest.method !== 'eth_sendTransaction') return editableRequest
	const reviewedSender = pending.transactionToSimulate.transaction.from
	return { ...editableRequest, params: [{ ...editableRequest.params[0], from: editableRequest.params[0].from ?? reviewedSender }] }
}

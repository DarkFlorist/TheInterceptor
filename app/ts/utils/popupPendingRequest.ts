import type { PendingTransaction, PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { getReviewedResultId } from '../background/reviewedResult.js'
import { assertNever } from './typescript.js'

// What a confirmation window is given of a stored request, which only the background sends. Each copy is stamped with the reviewed-result id of the stored request (getReviewedResultId), which the window returns unchanged with an accept. A message's signing input is left out. A transaction is given what the requested-network rule says about it at the moment the queue is sent, which getNetworkRefusalMessage derives and which is never stored.
export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage, getNetworkRefusalMessage: (transaction: PendingTransaction) => string | undefined): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction': {
			const networkRefusal = getNetworkRefusalMessage(pending)
			const shown = { ...pending, reviewedResultId: getReviewedResultId(pending) }
			return networkRefusal === undefined ? shown : { ...shown, networkRefusal }
		}
		case 'SignableMessage': {
			const base = {
				type: pending.type,
				popupOrTabId: pending.popupOrTabId,
				originalRequestParameters: pending.originalRequestParameters,
				simulationMode: pending.simulationMode,
				uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
				created: pending.created,
				website: pending.website,
				activeAddress: pending.activeAddress,
				approvalStatus: pending.approvalStatus,
				reviewedResultId: getReviewedResultId(pending),
			}
			const transactionOrMessageCreationStatus = pending.transactionOrMessageCreationStatus
			switch (transactionOrMessageCreationStatus) {
				case 'Simulated':
					return {
						...base,
						transactionOrMessageCreationStatus,
						visualizedPersonalSignRequest: pending.visualizedPersonalSignRequest,
					}
				case 'Crafting':
				case 'Simulating':
					return {
						...base,
						transactionOrMessageCreationStatus,
					}
				default:
					return assertNever(transactionOrMessageCreationStatus)
			}
		}
		default:
			return assertNever(pending)
	}
}

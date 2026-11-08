import type { ConfirmTransactionTransactionSingleVisualization, PendingTransactionOrSignableMessage, PopupConfirmTransactionTransactionSingleVisualization, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { assertNever } from './typescript.js'

// What a confirmation window is given of a stored visualisation: everything except the run that produced it, which only the background orders runs by.
function toPopupVisualisation(visualisation: ConfirmTransactionTransactionSingleVisualization): PopupConfirmTransactionTransactionSingleVisualization {
	if (visualisation.statusCode === 'success') {
		const { confirmationRunId: _confirmationRunId, ...data } = visualisation.data
		return { statusCode: 'success', data }
	}
	const { confirmationRunId: _confirmationRunId, ...data } = visualisation.data
	return { statusCode: 'failed', data }
}

// What a confirmation window is given of a stored request, which the background sends and the window also reads from storage. Background bookkeeping, the requested network and the simulation run of a transaction and the signing input of a message, is left out, so a change to it is never a change to what the windows parse.
export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction': {
			const { requestedChainId: _requestedChainId, ...transaction } = pending
			if (transaction.transactionOrMessageCreationStatus === 'Crafting' || transaction.transactionOrMessageCreationStatus === 'Simulating') return transaction
			return { ...transaction, popupVisualisation: toPopupVisualisation(transaction.popupVisualisation) }
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

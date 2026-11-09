import type { ConfirmTransactionTransactionSingleVisualization, PendingTransaction, PendingTransactionOrSignableMessage, PopupConfirmTransactionTransactionSingleVisualization, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
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

// What a confirmation window is given of a stored request, which only the background sends. Background bookkeeping, the requested network and the simulation run of a transaction and the signing input of a message, is left out, so a change to it is never a change to what the windows parse. A transaction is given what the requested-network rule says about it at the moment the queue is sent, which getNetworkRefusalMessage derives.
export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage, getNetworkRefusalMessage: (transaction: PendingTransaction) => string | undefined): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction': {
			const networkRefusal = getNetworkRefusalMessage(pending)
			const { requestedChainId: _requestedChainId, ...transaction } = pending
			const shown = networkRefusal === undefined ? transaction : { ...transaction, networkRefusal }
			if (shown.transactionOrMessageCreationStatus === 'Crafting' || shown.transactionOrMessageCreationStatus === 'Simulating') return shown
			return { ...shown, popupVisualisation: toPopupVisualisation(shown.popupVisualisation) }
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

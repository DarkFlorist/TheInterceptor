import type { ConfirmTransactionTransactionSingleVisualization, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { TransactionCreationError } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { getFailureReasonForDisplay } from './failureReasons.js'
import { appendProtocolRevertReasonHints } from './revertReasonHints.js'

// The only derivation of the reason shown when a transaction fails to be created: the insufficient balance explanation overrides the decoded revert reason.
export const getTransactionCreationFailureReason = (errorAbis: readonly AbiLike[], error: TransactionCreationError) => error.insufficientBalanceMessage ?? getFailureReasonForDisplay(errorAbis, error, appendProtocolRevertReasonHints)

const addMissingFailureReasonToVisualisation = (popupVisualisation: ConfirmTransactionTransactionSingleVisualization): ConfirmTransactionTransactionSingleVisualization => {
	const transactionToSimulate = popupVisualisation.data.transactionToSimulate
	if (transactionToSimulate.success || popupVisualisation.data.transactionCreationFailureReason !== undefined) return popupVisualisation
	const transactionCreationFailureReason = getTransactionCreationFailureReason([], transactionToSimulate.error)
	// Spread per status so TypeScript keeps each data shape paired with its statusCode.
	switch (popupVisualisation.statusCode) {
		case 'failed': return { ...popupVisualisation, data: { ...popupVisualisation.data, transactionCreationFailureReason } }
		case 'success': return { ...popupVisualisation, data: { ...popupVisualisation.data, transactionCreationFailureReason } }
	}
}

// Visualisations stored by versions before transactionCreationFailureReason existed lack it, so storage parsing fills it in here with the derivation the background uses. No contract ABIs are known at parse time, so custom errors stay undecoded until a confirmation refresh recomputes the reason; an insufficient balance explanation that an older version stored as the message only shows when the revert data carries no reason of its own.
export const addMissingTransactionCreationFailureReason = (pending: PendingTransactionOrSignableMessage): PendingTransactionOrSignableMessage => {
	if (pending.type !== 'Transaction') return pending
	if (pending.transactionOrMessageCreationStatus !== 'Simulated' && pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return pending
	return { ...pending, popupVisualisation: addMissingFailureReasonToVisualisation(pending.popupVisualisation) }
}

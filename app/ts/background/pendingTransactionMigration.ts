import { getTransactionCreationFailureReason } from '../simulation/transactionCreationFailureReason.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { getPendingTransactionsAndMessages, updatePendingTransactionOrMessages } from './storageVariables.js'

// Returns the pending entry unchanged unless its visualisation is missing the reason for a transaction that failed to be created.
const addMissingTransactionCreationFailureReason = (pending: PendingTransactionOrSignableMessage): PendingTransactionOrSignableMessage => {
	if (pending.type !== 'Transaction') return pending
	if (pending.transactionOrMessageCreationStatus !== 'Simulated' && pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return pending
	const popupVisualisation = pending.popupVisualisation
	const transactionToSimulate = popupVisualisation.data.transactionToSimulate
	if (transactionToSimulate.success || popupVisualisation.data.transactionCreationFailureReason !== undefined) return pending
	const transactionCreationFailureReason = getTransactionCreationFailureReason([], transactionToSimulate.error)
	// Spread per status so TypeScript keeps each data shape paired with its statusCode.
	switch (popupVisualisation.statusCode) {
		case 'failed': return { ...pending, popupVisualisation: { ...popupVisualisation, data: { ...popupVisualisation.data, transactionCreationFailureReason } } }
		case 'success': return { ...pending, popupVisualisation: { ...popupVisualisation, data: { ...popupVisualisation.data, transactionCreationFailureReason } } }
	}
}

// Visualisations stored by versions before transactionCreationFailureReason existed lack it, and the confirmation popup only reads that field. No contract ABIs are known here, so custom errors stay undecoded until a confirmation refresh recomputes the reason; an insufficient balance explanation that an older version stored as the message only shows when the revert data carries no reason of its own.
export async function migratePendingTransactionCreationFailureReasons() {
	const pendingTransactionsAndMessages = await getPendingTransactionsAndMessages()
	if (pendingTransactionsAndMessages.every((pending) => addMissingTransactionCreationFailureReason(pending) === pending)) return
	await updatePendingTransactionOrMessages(async (current) => current.map(addMissingTransactionCreationFailureReason))
}

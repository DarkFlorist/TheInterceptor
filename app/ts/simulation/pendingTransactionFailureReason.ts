import type { PendingTransaction } from '../types/accessRequest.js'
import { getTransactionCreationFailureReason } from './transactionCreationFailureReason.js'

// Pending transactions stored by older versions lack transactionCreationFailureReason. It is derived with the same function the background uses, but without contract ABIs, so their custom errors stay undecoded until the next confirmation refresh recomputes the reason. A reason that is already present is never replaced.
export const addMissingTransactionCreationFailureReason = (pending: PendingTransaction): PendingTransaction => {
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

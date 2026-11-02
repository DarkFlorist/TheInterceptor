import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { MaybeSimulatedTransaction, VisualizedSimulationState } from '../types/visualizer-types.js'

export function getResultsForTransaction(visualizedSimulationState: VisualizedSimulationState, transactionIdentifier: bigint) {
	return visualizedSimulationState.visualizedBlocks
		.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)
}

// The confirmation popup keeps Confirm disabled for these transactions unless forceSend is set (its override checkbox appears only for reverting or quarantined results; a failed simulation offers only rejection), and the background refuses to forward them without forceSend, so both sides share this one predicate.
export function requiresTransactionOverrideAcknowledgement(popupVisualisation: ConfirmTransactionTransactionSingleVisualization, transactionIdentifier: bigint) {
	if (popupVisualisation.statusCode !== 'success') return true
	const visualizedSimulationState = popupVisualisation.data.visualizedSimulationState
	if (visualizedSimulationState.success === false) return true
	const result = getResultsForTransaction(visualizedSimulationState, transactionIdentifier)
	return result === undefined || result.transactionStatus !== 'Transaction Succeeded' || result.quarantine
}

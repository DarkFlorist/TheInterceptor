import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { MaybeSimulatedTransaction, VisualizedSimulationState } from '../types/visualizer-types.js'

export const getResultsForTransaction = (visualizedSimulationState: VisualizedSimulationState, transactionIdentifier: bigint) => {
	return visualizedSimulationState.visualizedBlocks
		.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)
}

// The simulated result the popup shows for a transaction, or undefined when the simulation failed or produced no result for it, in which case the popup offers only rejection.
export const getVisualizedTransactionResult = (popupVisualisation: ConfirmTransactionTransactionSingleVisualization, transactionIdentifier: bigint) => {
	if (popupVisualisation.statusCode !== 'success' || popupVisualisation.data.visualizedSimulationState.success === false) return undefined
	return getResultsForTransaction(popupVisualisation.data.visualizedSimulationState, transactionIdentifier)
}

import type { ConfirmTransactionBatchVisualization, ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
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

// The calls of a wallet_sendCalls batch and the one simulation that ran them.
type TransactionBatchResultsInput = {
	readonly transactionsToSimulate: readonly { readonly transactionIdentifier: bigint }[]
	readonly popupVisualisation: ConfirmTransactionBatchVisualization
}

// Simulation results for each call of a batch in request order. A call without results could not be prepared or simulated.
export function getTransactionBatchCallResults(batch: TransactionBatchResultsInput): readonly (MaybeSimulatedTransaction | undefined)[] {
	if (batch.popupVisualisation.statusCode !== 'success') return batch.transactionsToSimulate.map(() => undefined)
	const simulatedTransactions = batch.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
	return batch.transactionsToSimulate.map((transactionToSimulate) => simulatedTransactions.find((simulatedTransaction) => simulatedTransaction.transactionIdentifier === transactionToSimulate.transactionIdentifier))
}

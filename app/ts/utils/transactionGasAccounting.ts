import type { SafeStackTransaction } from '../types/safeTypes.js'
import type { TransactionSimulationOptions } from '../types/visualizer-types.js'

export type TransactionGasAccounting = {
	readonly gasSpent: bigint
	readonly realizedGasPrice: bigint
	readonly safeTransaction?: SafeStackTransaction
	readonly simulationOptions?: TransactionSimulationOptions
}

// A Gnosis Safe's own call in simulation mode, which the simulation runs as its executor's execTransaction call (prepareSafeExecutionSimulationInput).
export function runsThroughGnosisSafe(transaction: Pick<TransactionGasAccounting, 'simulationOptions'>) {
	return transaction.simulationOptions?.executeThroughSafe === true
}

// A Gnosis Safe never pays for its own transaction: its executor does, whether outside the simulation (a Safe proposal) or inside it (runsThroughGnosisSafe).
export function isPaidByGnosisSafeExecutor(transaction: Pick<TransactionGasAccounting, 'safeTransaction' | 'simulationOptions'>) {
	return transaction.safeTransaction !== undefined || runsThroughGnosisSafe(transaction)
}

export function getGasFeePaidByTransactionSender(transaction: TransactionGasAccounting) {
	if (isPaidByGnosisSafeExecutor(transaction)) return 0n
	return transaction.gasSpent * transaction.realizedGasPrice
}

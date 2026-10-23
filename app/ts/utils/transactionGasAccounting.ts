import type { SafeStackTransaction } from '../types/safeTypes.js'
import type { TransactionSimulationOptions } from '../types/visualizer-types.js'

export type TransactionGasAccounting = {
	readonly gasSpent: bigint
	readonly realizedGasPrice: bigint
	readonly safeTransaction?: SafeStackTransaction
	readonly simulationOptions?: TransactionSimulationOptions
}

// A transaction a Gnosis Safe executes: a Safe proposal, or in simulation mode the Safe's own call. The simulation runs it through the Safe's execTransaction (safe/safeExecutionSimulation.ts), and the Safe never pays for it: its executor does.
export function isGnosisSafeExecution(transaction: Pick<TransactionGasAccounting, 'safeTransaction' | 'simulationOptions'>) {
	return transaction.safeTransaction !== undefined || transaction.simulationOptions?.executeThroughSafe === true
}

export function getGasFeePaidByTransactionSender(transaction: TransactionGasAccounting) {
	if (isGnosisSafeExecution(transaction)) return 0n
	return transaction.gasSpent * transaction.realizedGasPrice
}

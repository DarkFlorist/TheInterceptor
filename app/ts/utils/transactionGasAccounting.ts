import type { GnosisSafeStackTransaction } from '../types/gnosisSafeTypes.js'
import { authorizesExecutedCall, type TransactionSimulationOptions } from '../types/visualizer-types.js'

export type TransactionGasAccounting = {
	readonly gasSpent: bigint
	readonly realizedGasPrice: bigint
	readonly safeTransaction?: GnosisSafeStackTransaction
	readonly simulationOptions?: TransactionSimulationOptions
}

// A transaction a Gnosis Safe executes: a Gnosis Safe proposal, or in simulation mode the Gnosis Safe's own call. The simulation runs it as its executor's execTransaction call (authorizesExecutedCall, gnosisSafe/gnosisSafeExecutionSimulation.ts), and the Gnosis Safe never pays for it: its executor does.
export function isGnosisSafeExecution(transaction: Pick<TransactionGasAccounting, 'safeTransaction' | 'simulationOptions'>) {
	return authorizesExecutedCall(transaction)
}

export function getGasFeePaidByTransactionSender(transaction: TransactionGasAccounting) {
	if (isGnosisSafeExecution(transaction)) return 0n
	return transaction.gasSpent * transaction.realizedGasPrice
}

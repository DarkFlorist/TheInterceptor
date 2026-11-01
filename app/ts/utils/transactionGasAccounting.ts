import type { SafeStackTransaction } from '../types/safeTypes.js'
import { authorizesExecutedCall, type TransactionSimulationOptions } from '../types/visualizer-types.js'

export type TransactionGasAccounting = {
	readonly gasSpent: bigint
	readonly realizedGasPrice: bigint
	readonly safeTransaction?: SafeStackTransaction
	readonly simulationOptions?: TransactionSimulationOptions
}

// A Gnosis Safe never pays for its own transaction: its executor does, whether outside the simulation (a Safe proposal) or inside it (a transaction the node runs as its executor's call, authorizesExecutedCall).
export function isPaidByGnosisSafeExecutor(transaction: Pick<TransactionGasAccounting, 'safeTransaction' | 'simulationOptions'>) {
	return transaction.safeTransaction !== undefined || authorizesExecutedCall(transaction.simulationOptions)
}

export function getGasFeePaidByTransactionSender(transaction: TransactionGasAccounting) {
	if (isPaidByGnosisSafeExecutor(transaction)) return 0n
	return transaction.gasSpent * transaction.realizedGasPrice
}

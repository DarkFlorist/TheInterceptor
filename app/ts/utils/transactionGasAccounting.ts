import type { SafeStackTransaction } from '../types/safeTypes.js'

export type TransactionGasAccounting = {
	readonly gasSpent: bigint
	readonly realizedGasPrice: bigint
	readonly safeTransaction?: SafeStackTransaction
}

export function getGasFeePaidByTransactionSender(transaction: TransactionGasAccounting) {
	if (transaction.safeTransaction !== undefined) return 0n
	return transaction.gasSpent * transaction.realizedGasPrice
}

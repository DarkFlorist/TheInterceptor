import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { RequestedTransactionFees } from '../utils/transactionFees.js'

// Only the fee protector needs this comparison policy. The amount always comes from the resolved transaction, including zero-cost externally paid proposals.
export type FeeProtectionInput = {
	readonly comparison: 'total-price' | 'priority-fee'
	readonly pricePerGas: bigint
}

export function getFeeProtectionInput(transaction: EthereumUnsignedTransaction, requestedFees?: RequestedTransactionFees): FeeProtectionInput {
	if (transaction.type === 'legacy' || transaction.type === '2930') return { comparison: 'total-price', pricePerGas: transaction.gasPrice }
	// Explicit legacy requests use equal simulation caps; normalization supplies their comparison policy without passing RPC metadata to protectors.
	if (requestedFees?.feeModel === 'legacy') return { comparison: 'total-price', pricePerGas: transaction.maxFeePerGas }
	return { comparison: 'priority-fee', pricePerGas: transaction.maxPriorityFeePerGas }
}

import type { EthereumUnsignedTransaction } from '../types/wire-types.js'

// Simulation facts used by every protector, independent of request or popup lifecycle metadata.
export type TransactionProtectorContext = {
	readonly transaction: EthereumUnsignedTransaction
	readonly feeModel: 'legacy' | 'fee-market'
}

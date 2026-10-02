import { getRequestedTransactionFees } from '../utils/transactionFees.js'
import type { WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import type { TransactionProtectorContext } from '../simulation/protectorTypes.js'

export function getTransactionProtectorContext({ transaction, originalRequestParameters }: Pick<WebsiteCreatedEthereumTransaction, 'transaction' | 'originalRequestParameters'>): TransactionProtectorContext {
	const feeModel = transaction.type === 'legacy' || transaction.type === '2930' ? 'legacy'
		: originalRequestParameters.method === 'eth_sendTransaction' ? getRequestedTransactionFees(originalRequestParameters.params[0]).feeModel
		: 'fee-market'
	return { transaction, feeModel }
}

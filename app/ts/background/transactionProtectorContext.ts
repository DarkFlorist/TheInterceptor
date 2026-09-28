import type { WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import type { TransactionProtectorContext } from '../simulation/protectorTypes.js'

export function getTransactionProtectorContext({ transaction, originalRequestParameters }: Pick<WebsiteCreatedEthereumTransaction, 'transaction' | 'originalRequestParameters'>): TransactionProtectorContext {
	// Legacy requests are normalized into fee-cap transactions during crafting; retain their fee semantics at the request/simulation boundary.
	const usesLegacyFees = transaction.type === 'legacy' || transaction.type === '2930'
		|| (originalRequestParameters.method === 'eth_sendTransaction' && originalRequestParameters.params[0].gasPrice !== undefined)
	return { transaction, feeModel: usesLegacyFees ? 'legacy' : 'fee-market' }
}

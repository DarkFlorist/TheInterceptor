import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'

export async function selfTokenOops(transaction: EthereumUnsignedTransaction) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (transaction.to !== transferInfo.arguments.to) return
	return 'Attempt to send token to itself.'
}

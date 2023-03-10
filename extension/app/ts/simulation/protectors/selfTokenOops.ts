import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'

export async function selfTokenOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (transaction.to !== transferInfo.arguments.to) return
	return 'ERC20_ITSELF'
}

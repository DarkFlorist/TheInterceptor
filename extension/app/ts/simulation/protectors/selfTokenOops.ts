import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getTransferInfoFromTx } from '../../utils/calldata.js'

export async function selfTokenOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const transferInfo = getTransferInfoFromTx(transaction)
	if (transferInfo === undefined) return
	if (transaction.to !== transferInfo.to) return
	return 'ERC20_ITSELF'
}

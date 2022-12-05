import { Simulator } from '../simulator'
import { EthereumUnsignedTransaction } from "../../utils/wire-types"
import { getTransferInfoFromTx } from "../../utils/calldata"

export async function selfTokenOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const transferInfo = getTransferInfoFromTx(transaction)
	if (transferInfo === undefined) return
	if (transaction.to !== transferInfo.to) return
	return 'ERC20_ITSELF'
}

import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getTransferInfoFromTx } from '../../utils/calldata.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, simulator: Simulator) {
	const transferInfo = getTransferInfoFromTx(transaction)
	if (transferInfo === undefined) return
	const code = await simulator.ethereum.getCode(transferInfo.to)
	if (code.length === 0) return
	return 'ERC20_UNINTENDED_CONTRACT'
}

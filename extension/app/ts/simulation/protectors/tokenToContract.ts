import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, simulator: Simulator) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	const code = await simulator.ethereum.getCode(transferInfo.arguments.to)
	if (code.length === 0) return
	return 'ERC20_UNINTENDED_CONTRACT'
}

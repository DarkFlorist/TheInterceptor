import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, simulator: Simulator) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await simulator.ethereum.getCode(transaction.to)
	if (code.length > 0) return
	return 'EOA_CALLDATA'
}


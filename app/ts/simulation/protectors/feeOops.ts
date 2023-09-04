import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { SimulationState } from '../../types/visualizer-types.js'

export async function feeOops(transaction: EthereumUnsignedTransaction, simulator: Simulator, _simulationState: SimulationState) {
	if (transaction.type === '1559') { if (transaction.maxPriorityFeePerGas < 10n ** 9n) return } // 1.0 nanoEth/gas 
	else if (transaction.gasPrice < await simulator.ethereum.getGasPrice() * 10n) return // 10 times the estimate gas pice
	return 'BIG_FEE'
}

import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { SimulationState } from '../../utils/visualizer-types.js'

const MAX_FEE = 2000n * 10n**9n

export async function feeOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator, _simulationState: SimulationState) {
	if (transaction.type === '1559') { if (transaction.maxPriorityFeePerGas < MAX_FEE) return }
	else if (transaction.gasPrice < MAX_FEE) return
	return 'BIG_FEE'
}

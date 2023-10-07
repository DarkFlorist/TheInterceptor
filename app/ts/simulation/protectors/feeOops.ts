import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'

export async function feeOops(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, _simulationState: SimulationState) {
	if (transaction.type === '1559' && transaction.maxPriorityFeePerGas < 10n ** 9n) return // 1.0 nanoEth/gas
	if (transaction.type !== '1559' && transaction.gasPrice < await ethereum.getGasPrice() * 10n) return // 10 times the estimate gas price
	return 'BIG_FEE'
}

import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'

export async function feeOops(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState) {
	if (transaction.type === '1559' || transaction.type === '4844' || transaction.type === '7702') {
		if (transaction.maxPriorityFeePerGas < 10n ** 9n * 10n) return // 10.0 nanoEth/gas
		return `Attempt to send a transaction with an outrageous fee (${ transaction.maxPriorityFeePerGas / (10n ** 9n) } nanoEth/gas)`
	}
	const gasPrice = await ethereum.getGasPrice(requestAbortController)
	if (transaction.gasPrice < gasPrice * 10n) return // 10 times the estimate gas price
	return `Attempt to send a transaction with an outrageous fee. GasPrice: ${ gasPrice }`
}

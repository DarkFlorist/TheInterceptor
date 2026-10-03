import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import type { SimulationState } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'

export async function selfTokenOops(transaction: EthereumUnsignedTransaction, _ethereum: EthereumClientService, _requestAbortController: AbortController | undefined, _simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (transaction.to !== transferInfo.arguments.to) return
	return 'Attempt to send token to itself.'
}

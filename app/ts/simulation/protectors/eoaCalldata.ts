import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'
import { getCodeOrError } from './commonTokenOops.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await getCodeOrError(ethereum, requestAbortController, simulationState, transaction.to)
	if (code.statusCode === 'failure') return code.message
	if (code.getCodeReturn.length > 0) return
	return 'Transaction to an Externally Owned Account contains calldata.'
}


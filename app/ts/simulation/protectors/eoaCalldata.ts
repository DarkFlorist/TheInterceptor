import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'
import { EthereumClientService } from '../services/EthereumClientService.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, simulationState: SimulationState) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await getSimulatedCode(ethereum, simulationState, transaction.to)
	if (code.statusCode === 'failure') return 'FAILED_CHECK'
	if (code.getCodeReturn.length > 0) return
	return 'EOA_CALLDATA'
}


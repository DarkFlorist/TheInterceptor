import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { SimulationState } from '../../utils/visualizer-types.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, simulator: Simulator, simulationState: SimulationState) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await getSimulatedCode(simulator.ethereum, simulationState, transaction.to)
	if (code.statusCode === 'failure') return 'FAILED_CHECK'
	if (code.getCodeReturn.length > 0) return
	return 'EOA_CALLDATA'
}


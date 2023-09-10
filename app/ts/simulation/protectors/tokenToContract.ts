import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, simulator: Simulator, simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	const code = await getSimulatedCode(simulator.ethereum, simulationState, transferInfo.arguments.to)
	if (code.statusCode === 'failure') return 'FAILED_CHECK'
	if (code.getCodeReturn.length === 0) return
	return 'ERC20_SEND_TO_CONTRACT'
}

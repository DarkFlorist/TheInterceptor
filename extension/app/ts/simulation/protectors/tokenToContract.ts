import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../utils/visualizer-types.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, simulator: Simulator, simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	const code = await getSimulatedCode(simulator.ethereum, simulationState,transferInfo.arguments.to)
	if (code.length === 0) return
	return 'ERC20_UNINTENDED_CONTRACT'
}

import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'
import { SimulationState } from '../../types/visualizer-types.js'

export async function eoaApproval(transaction: EthereumUnsignedTransaction, controller: Simulator, simulationState: SimulationState) {
	const approvalInfo = parseTransaction(transaction)
	if (approvalInfo === undefined) return
	if (approvalInfo.name === 'approve') {
		if (approvalInfo.arguments.value === 0n) return // approving 0 is allowed
		const code = await getSimulatedCode(controller.ethereum, simulationState, approvalInfo.arguments.spender)
		if (code.statusCode === 'failure') return 'FAILED_CHECK'
		if (code.getCodeReturn.length > 0) return
		return 'EOA_APPROVAL'
	}
	if (approvalInfo.name === 'setApprovalForAll') {
		if (approvalInfo.arguments.approved === false) return // setting approval off is allowed
		const code = await getSimulatedCode(controller.ethereum, simulationState, approvalInfo.arguments.operator)
		if (code.statusCode === 'failure') return 'FAILED_CHECK'
		if (code.getCodeReturn.length > 0) return
		return 'EOA_APPROVAL'
	}
	return
}

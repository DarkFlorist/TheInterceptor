import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { getSimulatedCode } from '../services/SimulationModeEthereumClientService.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'

export async function eoaApproval(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, simulationState: SimulationState) {
	const approvalInfo = parseTransaction(transaction)
	if (approvalInfo === undefined) return
	if (approvalInfo.name === 'approve') {
		if (approvalInfo.arguments.value === 0n) return // approving 0 is allowed
		const code = await getSimulatedCode(ethereum, simulationState, approvalInfo.arguments.spender)
		if (code.statusCode === 'failure') return `Failed to verify whether address ${ approvalInfo.arguments.spender } contains code or not.`
		if (code.getCodeReturn.length > 0) return
		return 'This transaction attemps to approve Externally Owned Account.'
	}
	if (approvalInfo.name === 'setApprovalForAll') {
		if (approvalInfo.arguments.approved === false) return // setting approval off is allowed
		const code = await getSimulatedCode(ethereum, simulationState, approvalInfo.arguments.operator)
		if (code.statusCode === 'failure') return `Failed to verify whether address ${ approvalInfo.arguments.operator } contains code or not.`
		if (code.getCodeReturn.length > 0) return
		return 'This transaction attempts to approve an Externally Owned Account.'
	}
	return
}

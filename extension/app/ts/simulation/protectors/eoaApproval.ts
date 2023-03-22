import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'

export async function eoaApproval(transaction: EthereumUnsignedTransaction, controller: Simulator) {
	const approvalInfo = parseTransaction(transaction)
	if (approvalInfo === undefined) return
	if (approvalInfo.name === 'approve') {
		if (approvalInfo.arguments.value === 0n) return // approving 0 is allowed
		const code = await controller.simulationModeNode.getCode(approvalInfo.arguments.spender)
		if (code.length > 0) return
		return 'EOA_APPROVAL'
	}
	if (approvalInfo.name === 'setApprovalForAll') {
		if (approvalInfo.arguments.approved === false) return // setting approval off is allowed
		const code = await controller.simulationModeNode.getCode(approvalInfo.arguments.operator)
		if (code.length > 0) return
		return 'EOA_APPROVAL'
	}
	return
}

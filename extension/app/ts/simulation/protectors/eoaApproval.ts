import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getApprovalInfoFromTx } from '../../utils/calldata.js'

export async function eoaApproval(transaction: EthereumUnsignedTransaction, controller: Simulator) {
	const approvalInfo = getApprovalInfoFromTx(transaction)
	if (approvalInfo === undefined) return
	const code = await controller.ethereum.getCode(approvalInfo.spender)
	if (code.length > 0) return
	return 'EOA_APPROVAL'
}

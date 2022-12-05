import { Simulator } from '../simulator'
import { EthereumUnsignedTransaction } from "../../utils/wire-types"
import { getApprovalInfoFromTx } from "../../utils/calldata"

export async function eoaApproval(transaction: EthereumUnsignedTransaction, controller: Simulator) {
	const approvalInfo = getApprovalInfoFromTx(transaction)
	if (approvalInfo === undefined) return
	const code = await controller.ethereum.getCode(approvalInfo.spender)
	if (code.length > 0) return
	return 'EOA_APPROVAL'
}

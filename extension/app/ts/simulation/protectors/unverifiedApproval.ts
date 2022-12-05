import { Simulator } from '../simulator'
import { EthereumUnsignedTransaction } from "../../utils/wire-types"
import { getApprovalInfoFromTx } from "../../utils/calldata"

export async function unverifiedApproval(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const approvalInfo = getApprovalInfoFromTx(transaction)
	if (approvalInfo === undefined) return
	// TODO: how do we access etherscan?
	return
	/*
	const UNVERIFIED_APPROVAL_ERROR = "Approving an unverified contract"
	const isVerified = await controller.etherscan.isAddressVerified(approvalInfo.spender)
	if (isVerified) return // TODO store in DB that contract is verified
	return UNVERIFIED_APPROVAL_ERROR*/
}

import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'

export async function unverifiedApproval(_transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	// TODO: how do we access etherscan?
	return
	/*
	const UNVERIFIED_APPROVAL_ERROR = 'Approving an unverified contract'
	const isVerified = await controller.etherscan.isAddressVerified(approvalInfo.spender)
	if (isVerified) return // TODO store in DB that contract is verified
	return UNVERIFIED_APPROVAL_ERROR*/
}

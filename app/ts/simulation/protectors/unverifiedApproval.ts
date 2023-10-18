import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { SimulationState } from '../../types/visualizer-types.js'

export async function unverifiedApproval(_transaction: EthereumUnsignedTransaction, _simulator: Simulator, _simulationState: SimulationState) {
	// TODO: how do we access etherscan?
	return
	/*
	const UNVERIFIED_APPROVAL_ERROR = 'Approving an unverified contract'
	const isVerified = await controller.etherscan.isAddressVerified(approvalInfo.spender)
	if (isVerified) return // TODO store in DB that contract is verified
	return UNVERIFIED_APPROVAL_ERROR*/
}

import { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulationState } from '../types/visualizer-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'

const PROTECTORS = [
	selfTokenOops,
	commonTokenOops,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	chainIdMismatch,
]

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined) => {
	const reasons = await promiseAllMapAbortSafe(PROTECTORS, async (protectorMethod) => await protectorMethod(transaction.transaction, ethereum, requestAbortController, simulationState))
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}

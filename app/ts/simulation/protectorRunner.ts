import type { Protector } from './protectorTypes.js'
import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { FeeProtectionInput } from './feeProtection.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { createFeeProtector } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'

const createProtectors = (feeInput: FeeProtectionInput): readonly Protector[] => [
	selfTokenOops,
	commonTokenOops,
	createFeeProtector(feeInput),
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	chainIdMismatch,
]

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, eventsPromise: Promise<EnrichedEthereumEvents>, feeInput: FeeProtectionInput) => {
	const reasons = await promiseAllMapAbortSafe(createProtectors(feeInput), async (protectorMethod) => await protectorMethod(transaction, ethereum, requestAbortController, simulationState, eventsPromise))
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}

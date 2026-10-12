import type { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import type { WebsiteCreatedEthereumTransaction, SimulationState } from '../types/visualizer-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { sendToLookalikeAddress } from './protectors/sendToLookalikeAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'
import { createKnownAddressIndexesLoader, type KnownAddressIndexesLoader } from './lookalikeAddresses.js'

type Protector = (
	transaction: WebsiteCreatedEthereumTransaction['transaction'],
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SimulationState,
	eventsPromise: Promise<EnrichedEthereumEvents>,
	loadKnownAddressIndexes: KnownAddressIndexesLoader,
) => Promise<string | undefined>

const PROTECTORS: readonly Protector[] = [
	selfTokenOops,
	commonTokenOops,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	sendToLookalikeAddress,
	chainIdMismatch,
]

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: WebsiteCreatedEthereumTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, eventsPromise: Promise<EnrichedEthereumEvents>) => {
	const loadKnownAddressIndexes = createKnownAddressIndexesLoader(ethereum.getChainId())
	const reasons = await promiseAllMapAbortSafe(PROTECTORS, async (protectorMethod) => await protectorMethod(transaction.transaction, ethereum, requestAbortController, simulationState, eventsPromise, loadKnownAddressIndexes))
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}

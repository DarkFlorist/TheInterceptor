import type { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import type { WebsiteCreatedEthereumTransaction, SimulationState } from '../types/visualizer-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'

// A protector that finds several distinct problems returns one reason per problem, so the UI shows each in its own box.
type ProtectorReasons = string | readonly string[] | undefined

type Protector = (
	transaction: WebsiteCreatedEthereumTransaction['transaction'],
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SimulationState,
	eventsPromise: Promise<EnrichedEthereumEvents>,
) => Promise<ProtectorReasons>

const PROTECTORS: readonly Protector[] = [
	selfTokenOops,
	commonTokenOops,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	chainIdMismatch,
]

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: WebsiteCreatedEthereumTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, eventsPromise: Promise<EnrichedEthereumEvents>) => {
	const reasonsByProtector = await promiseAllMapAbortSafe(PROTECTORS, async (protectorMethod) => await protectorMethod(transaction.transaction, ethereum, requestAbortController, simulationState, eventsPromise))
	const reasons = reasonsByProtector.flatMap((protectorReasons) => protectorReasons ?? [])
	return {
		quarantine: reasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(reasons)),
	}
}

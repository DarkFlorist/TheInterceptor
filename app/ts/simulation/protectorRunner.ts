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

// Each protector returns one quarantine reason per problem it finds (none when the transaction looks fine), and the UI shows each reason in its own box.
type Protector = (
	transaction: WebsiteCreatedEthereumTransaction['transaction'],
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SimulationState,
	eventsPromise: Promise<EnrichedEthereumEvents>,
) => Promise<readonly string[]>

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
	const reasons = reasonsByProtector.flat()
	return {
		quarantine: reasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(reasons)),
	}
}

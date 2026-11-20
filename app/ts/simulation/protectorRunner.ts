import { selfTokenOops } from './protectors/selfTokenOops.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import type { WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'
import type { ProtectorChainReads } from './protectorChainReads.js'
import type { IdentifyAddress } from '../types/metadataLookups.js'

// Protectors receive only the chain reads and address identification they need; the live adapter owns the client and simulated-state details. Trailing parameters are omitted by protectors that do not use them.
type Protector = (
	transaction: WebsiteCreatedEthereumTransaction['transaction'],
	connectedChainId: bigint,
	chainReads: ProtectorChainReads,
	identify: IdentifyAddress,
	eventsPromise: Promise<EnrichedEthereumEvents>,
) => Promise<string | undefined>

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

export const runProtectorsForTransaction = async (chainReads: ProtectorChainReads, transaction: WebsiteCreatedEthereumTransaction, connectedChainId: bigint, identify: IdentifyAddress, eventsPromise: Promise<EnrichedEthereumEvents>) => {
	const reasons = await promiseAllMapAbortSafe(PROTECTORS, async (protectorMethod) => await protectorMethod(transaction.transaction, connectedChainId, chainReads, identify, eventsPromise))
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}

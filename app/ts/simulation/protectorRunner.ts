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

// A protector reads chain state only through chainReads, so the type keeps every chain read recorded with the run and replayable by an address-book re-label; the connected chain id is a plain value. A protector leaves off the trailing parameters it does not use, so identify comes after chainReads, which more protectors use without identifying an address.
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

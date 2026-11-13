// Forwards approved requests under the requested-network rule. It lives on its own so the transport (messageSending.ts, manifestV2Reconnect.ts) depends on no network policy or storage, and the rule (transactionNetwork.ts) depends on no delivery.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import type { CommitToStoredRequest } from './pendingRequestLocks.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { proceedOnRequestedNetwork, type RequestedNetworkCommit, type NetworkRefusal } from './transactionNetwork.js'

// Forwards a request to the signer like replyToInterceptedRequestAfterManifestV2Reconnect, but calls the requested-network check in the same synchronous step as every delivery attempt, including the retry after a Manifest V2 reconnect, which can outlast a network switch. A refused attempt ends the delivery and its refusal is returned. Every attempt is a commit of its own, as a rejection can arrive during the wait for a reconnect, and an attempt on a request that is no longer stored ends the delivery with nothing posted.
export async function forwardToSignerOnRequestedNetwork(websiteTabConnections: WebsiteTabConnections, ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage, message: InterceptedRequestForward, commitIfStillPending: CommitToStoredRequest): Promise<RequestedNetworkCommit<boolean | undefined>> {
	const refusals: NetworkRefusal[] = []
	const delivered = await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, async () => {
		const committed = await commitIfStillPending(async () => await proceedOnRequestedNetwork(ethereum, pending, () => replyToInterceptedRequest(websiteTabConnections, message)))
		if (!committed.stored) return undefined
		const attempt = committed.result
		if (attempt.committed) return attempt.result
		refusals.push(attempt.refusal)
		// Only a false result makes the reconnect helper retry, so a refused attempt ends the delivery.
		return undefined
	})
	const [refusal] = refusals
	return refusal === undefined ? { committed: true, result: delivered } : { committed: false, refusal }
}

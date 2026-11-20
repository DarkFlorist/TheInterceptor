// Forwards approved requests under the requested-network rule and the simulation-mode guard. It lives on its own so the transport (messageSending.ts, manifestV2Reconnect.ts) depends on no network policy or storage, and the rule (transactionNetwork.ts) depends on no delivery.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationModeGuard } from '../utils/simulationModeGuard.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import type { CommitToStoredRequest } from './pendingRequestLocks.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { proceedOnRequestedNetwork, type NetworkRefusal } from './transactionNetwork.js'

// How a forward to the signer ended: every attempt that was allowed was made, with delivered telling whether one reached the website's connection (undefined when the request was no longer stored); or an attempt was refused because the network changed, or because simulation mode was enabled after the approval started.
export type SignerForwarding =
	| { readonly outcome: 'attempted', readonly delivered: boolean | undefined }
	| { readonly outcome: 'networkRefusal', readonly refusal: NetworkRefusal }
	| { readonly outcome: 'simulationModeEnabled' }

type AttemptRefusal = Exclude<SignerForwarding, { readonly outcome: 'attempted' }>

// Forwards a request to the signer like replyToInterceptedRequestAfterManifestV2Reconnect, but calls the requested-network check and the simulation-mode guard in the same synchronous step as every delivery attempt, including the retry after a Manifest V2 reconnect, which can outlast a network or mode switch. A refused attempt ends the delivery and its refusal is returned. Every attempt is a commit of its own, as a rejection can arrive during the wait for a reconnect, and an attempt on a request that is no longer stored ends the delivery with nothing posted.
export async function forwardToSignerOnRequestedNetwork(websiteTabConnections: WebsiteTabConnections, ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage, message: InterceptedRequestForward, commitIfStillPending: CommitToStoredRequest, simulationModeGuard: SimulationModeGuard): Promise<SignerForwarding> {
	const refusals: AttemptRefusal[] = []
	const delivered = await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, async () => {
		const committed = await commitIfStillPending(async () => await proceedOnRequestedNetwork(ethereum, pending, () => simulationModeGuard.postSignerForwardIfAllowed(() => replyToInterceptedRequest(websiteTabConnections, message))))
		if (!committed.stored) return undefined
		const attempt = committed.result
		if (!attempt.committed) refusals.push({ outcome: 'networkRefusal', refusal: attempt.refusal })
		else if (!attempt.result.posted) refusals.push({ outcome: 'simulationModeEnabled' })
		else return attempt.result.result
		// Only a false result makes the reconnect helper retry, so a refused attempt ends the delivery.
		return undefined
	})
	const [refusal] = refusals
	return refusal ?? { outcome: 'attempted', delivered }
}

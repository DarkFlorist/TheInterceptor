import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { METAMASK_ERROR_BLANKET_ERROR, ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST } from '../utils/constants.js'
import { getRequestAccountAuthorizationFailure, type RequestAccountBinding } from '../utils/requestAccountAuthorization.js'
import type { SimulationModeGuard } from '../utils/simulationModeGuard.js'
import { getWebsiteSocketConnection } from './backgroundUtils.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { replyToInterceptedRequest } from './messageSending.js'

export type SignerForwarding = { readonly status: 'delivered' } | { readonly status: 'notDelivered' } | { readonly status: 'refused', readonly approvalStatus: PendingTransactionOrSignableMessage['approvalStatus'] }

export const SIMULATION_MODE_ENABLED_AFTER_REQUEST: PendingTransactionOrSignableMessage['approvalStatus'] = { status: 'SignerError', ...ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST.error }

// This owner checks live connection authority and simulation mode and posts in the same synchronous callback. MV2 retries can only enter through that callback again, so no caller can accidentally retain an authorization result across the reconnect await.
export async function forwardAuthorizedSignerRequest(connections: WebsiteTabConnections, message: Extract<InterceptedRequestForward, { readonly type: 'forwardToSigner' }>, binding: RequestAccountBinding & { readonly websiteAccount: bigint }, simulationModeGuard: SimulationModeGuard): Promise<SignerForwarding> {
	let refusal: PendingTransactionOrSignableMessage['approvalStatus'] | undefined
	const delivered = await attemptDeliveryAfterManifestV2Reconnect(connections, message, () => {
		const failure = getRequestAccountAuthorizationFailure(getWebsiteSocketConnection(connections, message.uniqueRequestIdentifier.requestSocket), binding)
		if (failure !== undefined) {
			refusal = { status: 'SignerError', code: METAMASK_ERROR_BLANKET_ERROR, message: failure }
			// Undefined stops delivery without requesting a content-script reconnect.
			return undefined
		}
		const delivery = simulationModeGuard.postSignerForwardIfAllowed(() => replyToInterceptedRequest(connections, message))
		if (delivery.posted) return delivery.result
		refusal = SIMULATION_MODE_ENABLED_AFTER_REQUEST
		return undefined
	})
	if (refusal !== undefined) return { status: 'refused', approvalStatus: refusal }
	return delivered === true ? { status: 'delivered' } : { status: 'notDelivered' }
}

import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { authorizeSignerForward } from './signerExecutionAuthority.js'

// Confirmation can outlive a signer connection. Reconnect retries must repeat admission before producing each wallet forward.
export async function sendSignerForwardAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: Extract<InterceptedRequestForward, { readonly type: 'forwardToSigner' }>) {
	return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, () => replyToInterceptedRequest(websiteTabConnections, authorizeSignerForward(websiteTabConnections, message)))
}

import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { getWebsiteSocketConnection } from './backgroundUtils.js'
import { forwardNativeGnosisSafeAppsSignerRequest } from './nativeGnosisSafeAppsSigner.js'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'

export function routeProviderReply(connections: WebsiteTabConnections, message: InterceptedRequestForward) {
	if (message.type === 'forwardToSigner' && getWebsiteSocketConnection(connections, message.uniqueRequestIdentifier.requestSocket)?.nativeSafeRole?.kind === 'host') return forwardNativeGnosisSafeAppsSignerRequest(connections, message, sendSubscriptionReplyOrCallBackToPort)
	return replyToInterceptedRequest(connections, message)
}

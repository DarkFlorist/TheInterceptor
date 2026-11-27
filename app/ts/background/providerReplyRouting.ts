import { getNativeGnosisSafeAppsAuthority } from './nativeGnosisSafeAppsSessions.js'
import { gnosisSafeAppsCommandLifecycle } from './gnosisSafeAppsCommandBinding.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { getWebsiteSocketConnection } from './backgroundUtils.js'
import { forwardNativeGnosisSafeAppsSignerRequest } from './nativeGnosisSafeAppsSigner.js'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'

export function routeProviderReply(connections: WebsiteTabConnections, message: InterceptedRequestForward) {
	if (message.type === 'result') {
		const connection = getWebsiteSocketConnection(connections, message.uniqueRequestIdentifier.requestSocket)
		// Tracked request identity, rather than the terminal method name, owns private-command settlement.
		if (connection !== undefined) gnosisSafeAppsCommandLifecycle.settle(connection.port, message.uniqueRequestIdentifier.requestId, 'error' in message ? undefined : message.result)
	}
	if (message.type === 'forwardToSigner') {
		const connection = getWebsiteSocketConnection(connections, message.uniqueRequestIdentifier.requestSocket)
		const authority = connection === undefined ? undefined : getNativeGnosisSafeAppsAuthority(connections, connection.port)
		if (authority?.kind === 'staleHost') return false
		if (authority?.kind === 'host') return forwardNativeGnosisSafeAppsSignerRequest(connections, message, sendSubscriptionReplyOrCallBackToPort)
	}
	return replyToInterceptedRequest(connections, message)
}

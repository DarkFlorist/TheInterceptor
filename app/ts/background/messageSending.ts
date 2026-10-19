import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { attemptDeliveryAfterManifestV2Reconnect, attemptSocketDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'

function postMessageToPortIfConnected(port: browser.runtime.Port, message: InterceptorMessageToInpage) {
	try {
		checkAndThrowRuntimeLastError()
		port.postMessage(serialize(InterceptorMessageToInpage, message) as Object)
		checkAndThrowRuntimeLastError()
		return true
	} catch (error) {
		if (error instanceof Error && isIgnorablePortLifecycleError(error)) return false
		if (isMissingBrowserTargetError(error)) return false
		throw error
	}
}

export function replyToInterceptedRequest(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	if (message.type === 'doNotReply') return
	const tabConnection = websiteTabConnections.get(message.uniqueRequestIdentifier.requestSocket.tabId)
	const identifier = websiteSocketToString(message.uniqueRequestIdentifier.requestSocket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (connection === undefined) throw new Error('connection was undefined')
		if (socketAsString !== identifier) continue
		return postMessageToPortIfConnected(connection.port, {
			...message,
			interceptorApproved: true,
			requestId: message.uniqueRequestIdentifier.requestId,
			...(message.type === 'result' ? { bridgeRequestSettled: true as const } : {}),
		})
	}
	return false
}

export async function replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, () => replyToInterceptedRequest(websiteTabConnections, message))
}

type GuardedDeliveryAttempt<Refusal> = { readonly committed: true, readonly result: boolean | undefined } | { readonly committed: false, readonly refusal: Refusal }

// Delivers like replyToInterceptedRequestAfterManifestV2Reconnect, but runs every delivery attempt, including the retry after a Manifest V2 reconnect, through guardAttempt, which either makes the attempt or refuses it. A refused attempt ends the delivery and its refusal is returned.
export async function replyToInterceptedRequestAfterManifestV2ReconnectWithGuard<Refusal>(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward, guardAttempt: (deliver: () => boolean | undefined) => Promise<GuardedDeliveryAttempt<Refusal>>): Promise<GuardedDeliveryAttempt<Refusal>> {
	const refusals: Refusal[] = []
	const delivered = await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, async () => {
		const attempt = await guardAttempt(() => replyToInterceptedRequest(websiteTabConnections, message))
		if (attempt.committed) return attempt.result
		refusals.push(attempt.refusal)
		// Only a false result makes the reconnect helper retry, so a refused attempt ends the delivery.
		return undefined
	})
	const [refusal] = refusals
	return refusal === undefined ? { committed: true, result: delivered } : { committed: false, refusal }
}

export function sendSubscriptionReplyOrCallBackToPort(port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) {
	return postMessageToPortIfConnected(port, {...message, interceptorApproved: true })
}

export function sendSubscriptionReplyOrCallBack(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (connection === undefined) throw new Error('connection was undefined')
		if (socketAsString !== identifier) continue
		return postMessageToPortIfConnected(connection.port, { ...message, interceptorApproved: true })
	}
	return false
}

export async function sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	return await attemptSocketDeliveryAfterManifestV2Reconnect(websiteTabConnections, socket, () => sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, message))
}

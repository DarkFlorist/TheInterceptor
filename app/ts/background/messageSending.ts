import { type InterceptedRequestForward, serializeInpageReply, serializeInpageCallback, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { attemptDeliveryAfterManifestV2Reconnect, attemptSocketDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'

type OutboundInpageMessage =
	| { readonly kind: 'reply', readonly value: Parameters<typeof serializeInpageReply>[0] }
	| { readonly kind: 'callback', readonly value: Parameters<typeof serializeInpageCallback>[0] }

function postMessageToPortIfConnected(port: browser.runtime.Port, message: OutboundInpageMessage) {
	try {
		checkAndThrowRuntimeLastError()
		port.postMessage(message.kind === 'reply' ? serializeInpageReply(message.value) : serializeInpageCallback(message.value))
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
		if (message.type === 'forwardToSigner' && connection.forwardToSigner !== undefined) return connection.forwardToSigner(message)
		const reply = {
			...message,
			interceptorApproved: true as const,
			requestId: message.uniqueRequestIdentifier.requestId,
			...(message.type === 'result' ? { bridgeRequestSettled: true as const } : {}),
		}
		return postMessageToPortIfConnected(connection.port, { kind: 'reply', value: reply })
	}
	return false
}

export async function replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, () => replyToInterceptedRequest(websiteTabConnections, message))
}

export function sendSubscriptionReplyOrCallBackToPort(port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) {
	return postMessageToPortIfConnected(port, { kind: 'callback', value: { ...message, interceptorApproved: true } })
}

export function sendSubscriptionReplyOrCallBack(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (connection === undefined) throw new Error('connection was undefined')
		if (socketAsString !== identifier) continue
		return sendSubscriptionReplyOrCallBackToPort(connection.port, message)
	}
	return false
}

export async function sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	return await attemptSocketDeliveryAfterManifestV2Reconnect(websiteTabConnections, socket, () => sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, message))
}

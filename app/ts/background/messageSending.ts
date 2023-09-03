import { InterceptedRequestForward, InterceptorMessageToInpage, SubscriptionReplyOrCallBack } from "../types/interceptor-messages.js"
import { WebsiteSocket } from "../utils/requests.js"
import { WebsiteTabConnections } from "../types/user-interface-types.js"
import { websiteSocketToString } from "./backgroundUtils.js"

function postMessageToPortIfConnected(port: browser.runtime.Port, message: InterceptorMessageToInpage) {
	try {
		port.postMessage(InterceptorMessageToInpage.serialize(message) as Object)
	} catch (error) {
		if (error instanceof Error) {
			if (error.message?.includes('Attempting to use a disconnected port object')) {
				return
			}
			if (error.message?.includes('Could not establish connection. Receiving end does not exist')) {
				return
			}
		}
		throw error
	}
}
export function postMessageIfStillConnected(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: InterceptorMessageToInpage) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (socketAsString !== identifier) continue
		postMessageToPortIfConnected(connection.port, message)
	}
	return true
}

export function replyToInterceptedRequest(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	const tabConnection = websiteTabConnections.get(message.uniqueRequestIdentifier.requestSocket.tabId)
	const identifier = websiteSocketToString(message.uniqueRequestIdentifier.requestSocket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (socketAsString !== identifier) continue
		postMessageToPortIfConnected(connection.port, { ...message, interceptorApproved: true, requestId: message.uniqueRequestIdentifier.requestId })
	}
	return true
}

export function sendSubscriptionReplyOrCallBackToPort(port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) {
	postMessageToPortIfConnected(port, {...message, interceptorApproved: true })
}

export function sendSubscriptionReplyOrCallBack(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (socketAsString !== identifier) continue
		postMessageToPortIfConnected(connection.port, { ...message, interceptorApproved: true })
	}
	return true
}

import { InterceptedRequestForward, InterceptorMessageToInpage, SubscriptionReplyOrCallBack } from "../types/interceptor-messages.js"
import { WebsiteSocket, checkAndPrintRuntimeLastError } from "../utils/requests.js"
import { WebsiteTabConnections } from "../types/user-interface-types.js"
import { websiteSocketToString } from "./backgroundUtils.js"
import { serialize } from "../types/wire-types.js"

function postMessageToPortIfConnected(port: browser.runtime.Port, message: InterceptorMessageToInpage) {
	try {
		checkAndPrintRuntimeLastError()
		port.postMessage(serialize(InterceptorMessageToInpage, message) as Object)
	} catch (error) {
		if (error instanceof Error) {
			if (error.message?.includes('Attempting to use a disconnected port object')) return
			if (error.message?.includes('Could not establish connection. Receiving end does not exist')) return
			if (error.message?.includes('No tab with id')) return
		}
		throw error
	}
	checkAndPrintRuntimeLastError()
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
		if (connection === undefined) throw new Error('connection was undefined')
		if (socketAsString !== identifier) continue
		postMessageToPortIfConnected(connection.port, { ...message, interceptorApproved: true })
	}
	return true
}

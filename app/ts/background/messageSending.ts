import { InterceptedRequestForward, InterceptorMessageToInpage, SubscriptionReplyOrCallBack } from "../types/interceptor-messages.js"
import { WebsiteSocket, checkAndPrintRuntimeLastError } from "../utils/requests.js"
import { PAGE_RPC_EVENT, PAGE_RPC_RESPONSE, createPageEventEnvelope, createPageResponseEnvelope } from "../messages/page.js"
import { PageSessionStore } from "./pageSessions.js"

function postMessageToPortIfConnected(port: browser.runtime.Port, action: typeof PAGE_RPC_RESPONSE | typeof PAGE_RPC_EVENT, id: number | undefined, message: InterceptorMessageToInpage) {
	try {
		checkAndPrintRuntimeLastError()
		const envelope = action === PAGE_RPC_RESPONSE && id !== undefined
			? createPageResponseEnvelope(id, message)
			: createPageEventEnvelope(message)
		port.postMessage(envelope)
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

export function replyToInterceptedRequest(pageSessions: PageSessionStore, message: InterceptedRequestForward) {
	if (message.type === 'doNotReply') return
	const connection = pageSessions.get(message.uniqueRequestIdentifier.requestSocket)
	if (connection === undefined) return false
	postMessageToPortIfConnected(connection.port, PAGE_RPC_RESPONSE, message.uniqueRequestIdentifier.requestId, { ...message, interceptorApproved: true, requestId: message.uniqueRequestIdentifier.requestId })
	return true
}

export function sendSubscriptionReplyOrCallBackToPort(port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) {
	postMessageToPortIfConnected(port, PAGE_RPC_EVENT, undefined, {...message, interceptorApproved: true })
}

export function sendSubscriptionReplyOrCallBack(pageSessions: PageSessionStore, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	const connection = pageSessions.get(socket)
	if (connection === undefined) return false
	postMessageToPortIfConnected(connection.port, PAGE_RPC_EVENT, undefined, { ...message, interceptorApproved: true })
	return true
}

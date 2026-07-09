import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'

const ACCESS_DEBUG_PREFIX = '[Interceptor access debug]'
const hasBridgeMethod = (message: InterceptorMessageToInpage): message is InterceptorMessageToInpage & { readonly method: string } => 'method' in message
const shouldLogAccessBridgeMessage = (message: InterceptorMessageToInpage & { readonly method: string }) => message.method === 'wallet_requestPermissions'
const summarizeBridgeMessage = (message: InterceptorMessageToInpage & { readonly method: string }) => {
	if (message.type !== 'result') return { type: message.type, method: message.method, requestId: message.requestId }
	if ('error' in message) return { type: message.type, method: message.method, requestId: message.requestId, errorCode: message.error.code, errorMessage: message.error.message }
	if (message.method === 'accountsChanged' || message.method === 'eth_accounts') {
		return {
			type: message.type,
			method: message.method,
			requestId: message.requestId,
			result: Array.isArray(message.result) ? message.result : message.result,
		}
	}
	return { type: message.type, method: message.method, requestId: message.requestId, result: message.result }
}

function postMessageToPortIfConnected(port: browser.runtime.Port, message: InterceptorMessageToInpage) {
	try {
		checkAndThrowRuntimeLastError()
		if (hasBridgeMethod(message) && shouldLogAccessBridgeMessage(message)) {
			console.warn(ACCESS_DEBUG_PREFIX, 'background sending message to inpage', summarizeBridgeMessage(message))
		}
		port.postMessage(serialize(InterceptorMessageToInpage, message) as Object)
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (error instanceof Error && isIgnorablePortLifecycleError(error)) return
		if (isMissingBrowserTargetError(error)) return
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

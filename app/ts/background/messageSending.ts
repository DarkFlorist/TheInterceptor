import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'

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
		return postMessageToPortIfConnected(connection.port, { ...message, interceptorApproved: true, requestId: message.uniqueRequestIdentifier.requestId })
	}
	return false
}

const waitForReplacementWebsiteConnection = async (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, previousPort: browser.runtime.Port | undefined) => {
	const identifier = websiteSocketToString(socket)
	const deadline = Date.now() + 1_000
	while (true) {
		const currentPort = websiteTabConnections.get(socket.tabId)?.connections[identifier]?.port
		if (currentPort !== undefined && currentPort !== previousPort) return true
		const remainingTime = deadline - Date.now()
		if (remainingTime <= 0) return false
		await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingTime)))
	}
}

export const requestManifestV2ContentScriptReconnect = async (socket: WebsiteSocket) => {
	try {
		await browser.tabs.sendMessage(socket.tabId, {
			method: 'interceptor_reconnect_content_script_port',
			connectionName: serialize(EthereumQuantity, socket.connectionName),
		})
		return true
	} catch (error: unknown) {
		if (error instanceof Error && isIgnorablePortLifecycleError(error)) return false
		if (isMissingBrowserTargetError(error)) return false
		throw error
	}
}

export async function replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	const socket = message.uniqueRequestIdentifier.requestSocket
	const previousPort = websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.port
	const delivered = replyToInterceptedRequest(websiteTabConnections, message)
	if (delivered !== false || browser.runtime.getManifest().manifest_version !== 2 || message.type === 'doNotReply') return delivered
	if (!await requestManifestV2ContentScriptReconnect(socket)) return false
	if (!await waitForReplacementWebsiteConnection(websiteTabConnections, socket, previousPort)) return false
	return replyToInterceptedRequest(websiteTabConnections, message)
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

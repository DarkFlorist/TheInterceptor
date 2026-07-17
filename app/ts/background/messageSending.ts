import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { attemptDeliveryAfterManifestV2Reconnect, attemptSocketDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { socketCanExecuteWithSelectedSigner } from './signerExecutionAuthority.js'
import { METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'

const isSignerTouchingCallback = (message: SubscriptionReplyOrCallBack) => message.method === 'request_signer_to_eth_requestAccounts'
	|| message.method === 'request_signer_to_eth_accounts'
	|| message.method === 'request_signer_chainId'
	|| message.method === 'request_signer_to_wallet_switchEthereumChain'

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
	const authorizedMessage = message.type === 'forwardToSigner' && !socketCanExecuteWithSelectedSigner(message.uniqueRequestIdentifier.requestSocket)
		? {
			...message,
			type: 'result' as const,
			error: {
				code: METAMASK_ERROR_NOT_AUTHORIZED,
				message: 'The selected signer provider is not ready for this frame. Retry the request after wallet synchronization completes.',
			},
		}
		: message
	const tabConnection = websiteTabConnections.get(authorizedMessage.uniqueRequestIdentifier.requestSocket.tabId)
	const identifier = websiteSocketToString(authorizedMessage.uniqueRequestIdentifier.requestSocket)
	if (tabConnection === undefined) return false
	for (const socketAsString in tabConnection.connections) {
		const connection = tabConnection.connections[socketAsString]
		if (connection === undefined) throw new Error('connection was undefined')
		if (socketAsString !== identifier) continue
		return postMessageToPortIfConnected(connection.port, {
			...authorizedMessage,
			interceptorApproved: true,
			requestId: authorizedMessage.uniqueRequestIdentifier.requestId,
			...(authorizedMessage.type === 'result' ? { bridgeRequestSettled: true as const } : {}),
		})
	}
	return false
}

export async function replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, () => replyToInterceptedRequest(websiteTabConnections, message))
}

export function sendSubscriptionReplyOrCallBackToPort(port: browser.runtime.Port, message: SubscriptionReplyOrCallBack) {
	postMessageToPortIfConnected(port, {...message, interceptorApproved: true })
}

export function sendSubscriptionReplyOrCallBack(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	if (isSignerTouchingCallback(message) && !socketCanExecuteWithSelectedSigner(socket)) return false
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

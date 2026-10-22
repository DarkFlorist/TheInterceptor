import { hasOwnKey } from '../utils/typescript.js'
import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack, type InpageScriptCommand } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSocketFromPort, websiteSocketToString } from './backgroundUtils.js'
import { serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { attemptDeliveryAfterManifestV2Reconnect, attemptSocketDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { authorizeSignerForward, socketCanExecuteWithSelectedSigner } from './signerExecutionAuthority.js'

// Wallet commands require execution authority. Website-state producers apply website/address consent and accountIdentityPolicy; chain state comes from Interceptor's configured RPC, and disconnect/disabled events must clear stale state even without a wallet.
const callbackAuthority = {
	request_signer_connection_status: 'discovery',
	request_signer_provider_catalog: 'discovery',
	select_signer_provider: 'discovery',
	request_signer_chainId: 'signer',
	request_signer_to_wallet_switchEthereumChain: 'signer',
	request_signer_to_wallet_watchAsset: 'signer',
	request_signer_to_eth_requestAccounts: 'signer',
	request_signer_to_eth_accounts: 'signer',
	disconnect: 'website-state',
	connect: 'website-state',
	accountsChanged: 'website-state',
	chainChanged: 'website-state',
	safe_apps_compatibility: 'website-state',
} satisfies Record<InpageScriptCommand['method'], 'signer' | 'discovery' | 'website-state'>

const isSignerTouchingCallback = (message: SubscriptionReplyOrCallBack) => hasOwnKey(callbackAuthority, message.method) && callbackAuthority[message.method] === 'signer'

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
	// Revalidate after asynchronous confirmation: the tab's selected signer can change while the user considers a request.
	const authorizedMessage = authorizeSignerForward(message)
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
	if (isSignerTouchingCallback(message)) {
		const socket = getSocketFromPort(port)
		if (socket === undefined || !socketCanExecuteWithSelectedSigner(socket)) return false
	}
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
		return sendSubscriptionReplyOrCallBackToPort(connection.port, message)
	}
	return false
}

export async function sendSubscriptionReplyOrCallBackAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: SubscriptionReplyOrCallBack) {
	return await attemptSocketDeliveryAfterManifestV2Reconnect(websiteTabConnections, socket, () => sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, message))
}

import { type InterceptedRequestForward, InterceptorMessageToInpage, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError, getUniqueRequestIdentifierString, isMissingBrowserTargetError } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { appendPendingTerminalReply, getPendingTerminalReplies, removePendingTerminalReply } from './pendingTerminalReplies.js'
import { Semaphore } from '../utils/semaphore.js'
import { reportLocalRecovery } from '../utils/errors.js'

const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
const completedTerminalReplies = new Set<string>()
const terminalReplySemaphore = new Semaphore(1)
const terminalReplyFlushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const TERMINAL_REPLY_FLUSH_RETRY_DELAY_MS = 50

async function finishPreviouslyDeliveredTerminalReply(identifier: string, message: InterceptedRequestForward) {
	if (!completedTerminalReplies.has(identifier)) return false
	await removePendingTerminalReply(message.uniqueRequestIdentifier)
	completedTerminalReplies.delete(identifier)
	return true
}

async function recordSuccessfulTerminalReplyDelivery(identifier: string, message: InterceptedRequestForward, keepCompletionMarker: boolean) {
	completedTerminalReplies.add(identifier)
	await removePendingTerminalReply(message.uniqueRequestIdentifier)
	if (!keepCompletionMarker) completedTerminalReplies.delete(identifier)
}

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

const requestManifestV2ContentScriptReconnect = async (socket: WebsiteSocket) => {
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

export async function queueTerminalReplyAndAttemptDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	const identifier = getUniqueRequestIdentifierString(message.uniqueRequestIdentifier)
	const existingProduction = terminalReplyProductions.get(identifier)
	if (existingProduction !== undefined) return await existingProduction
	const production = (async () => {
		let delivered = await terminalReplySemaphore.execute(async () => {
			if (await finishPreviouslyDeliveredTerminalReply(identifier, message)) return true
			await appendPendingTerminalReply(message)
			const initialDelivery = replyToInterceptedRequest(websiteTabConnections, message)
			if (initialDelivery === true) await recordSuccessfulTerminalReplyDelivery(identifier, message, false)
			return initialDelivery
		})
		if (delivered !== false || browser.runtime.getManifest().manifest_version !== 2 || message.type === 'doNotReply') return delivered
		if (!await requestManifestV2ContentScriptReconnect(message.uniqueRequestIdentifier.requestSocket)) return false
		delivered = await terminalReplySemaphore.execute(async () => {
			if (await finishPreviouslyDeliveredTerminalReply(identifier, message)) return true
			const reconnectDelivery = replyToInterceptedRequest(websiteTabConnections, message)
			if (reconnectDelivery === true) await recordSuccessfulTerminalReplyDelivery(identifier, message, false)
			return reconnectDelivery
		})
		return delivered
	})()
	terminalReplyProductions.set(identifier, production)
	try {
		return await production
	} finally {
		if (terminalReplyProductions.get(identifier) === production) terminalReplyProductions.delete(identifier)
	}
}

export async function flushPendingTerminalRepliesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return await terminalReplySemaphore.execute(async () => {
		const pendingReplies = await getPendingTerminalReplies()
		let deliveredReplies = 0
		for (const reply of pendingReplies) {
			const replySocket = reply.uniqueRequestIdentifier.requestSocket
			if (replySocket.tabId !== socket.tabId || replySocket.connectionName !== socket.connectionName) continue
			const identifier = getUniqueRequestIdentifierString(reply.uniqueRequestIdentifier)
			if (completedTerminalReplies.has(identifier)) {
				await removePendingTerminalReply(reply.uniqueRequestIdentifier)
				continue
			}
			if (replyToInterceptedRequest(websiteTabConnections, reply) !== true) continue
			await recordSuccessfulTerminalReplyDelivery(identifier, reply, terminalReplyProductions.has(identifier))
			deliveredReplies += 1
		}
		return deliveredReplies
	})
}

export async function flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, port: browser.runtime.Port) {
	const socketIdentifier = websiteSocketToString(socket)
	const existingRetryTimer = terminalReplyFlushRetryTimers.get(socketIdentifier)
	if (existingRetryTimer !== undefined) {
		clearTimeout(existingRetryTimer)
		terminalReplyFlushRetryTimers.delete(socketIdentifier)
	}
	try {
		return await flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
	} catch (error) {
		await reportLocalRecovery(error, {
			source: 'pending_terminal_replies',
			code: 'pending_terminal_reply_socket_flush_failed',
			message: 'Retrying terminal reply delivery while the website connection remains active.',
		})
		const retryTimer = setTimeout(() => {
			terminalReplyFlushRetryTimers.delete(socketIdentifier)
			const currentPort = websiteTabConnections.get(socket.tabId)?.connections[socketIdentifier]?.port
			if (currentPort !== port) return
			void flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, socket, port)
		}, TERMINAL_REPLY_FLUSH_RETRY_DELAY_MS)
		terminalReplyFlushRetryTimers.set(socketIdentifier, retryTimer)
		return 0
	}
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

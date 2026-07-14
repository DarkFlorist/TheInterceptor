import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { getUniqueRequestIdentifierString, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest, requestManifestV2ContentScriptReconnect } from './messageSending.js'
import { appendPendingTerminalReply, getPendingTerminalReplies, removePendingTerminalReply } from './pendingTerminalReplies.js'

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

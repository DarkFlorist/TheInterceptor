import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { getUniqueRequestIdentifierString, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { appendPendingTerminalReply, getPendingTerminalReplies, removePendingTerminalReply } from './pendingTerminalReplies.js'
import { createBackoffRetryScheduler } from '../utils/retryScheduler.js'

const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
const terminalReplyReservations = new Set<string>()
const completedTerminalReplies = new Set<string>()
const terminalReplySemaphore = new Semaphore(1)
const terminalReplyFlushRetries = new Map<string, { port: browser.runtime.Port, scheduler: ReturnType<typeof createBackoffRetryScheduler> }>()

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

export async function queueTerminalReply(message: InterceptedRequestForward) {
	const identifier = getUniqueRequestIdentifierString(message.uniqueRequestIdentifier)
	terminalReplyReservations.add(identifier)
	try {
		await terminalReplySemaphore.execute(async () => {
			await appendPendingTerminalReply(message)
		})
	} catch (error) {
		terminalReplyReservations.delete(identifier)
		throw error
	}
}

export async function attemptQueuedTerminalReplyDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	const identifier = getUniqueRequestIdentifierString(message.uniqueRequestIdentifier)
	const existingProduction = terminalReplyProductions.get(identifier)
	if (existingProduction !== undefined) return await existingProduction
	const production = (async () => {
		const deliver = async () => await terminalReplySemaphore.execute(async () => {
			if (await finishPreviouslyDeliveredTerminalReply(identifier, message)) return true
			const delivery = replyToInterceptedRequest(websiteTabConnections, message)
			if (delivery === true) await recordSuccessfulTerminalReplyDelivery(identifier, message, false)
			return delivery
		})
		return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, deliver)
	})()
	terminalReplyProductions.set(identifier, production)
	try {
		return await production
	} finally {
		if (terminalReplyProductions.get(identifier) === production) terminalReplyProductions.delete(identifier)
		terminalReplyReservations.delete(identifier)
	}
}

export async function queueTerminalReplyAndAttemptDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	await queueTerminalReply(message)
	return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, message)
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
			await recordSuccessfulTerminalReplyDelivery(identifier, reply, terminalReplyProductions.has(identifier) || terminalReplyReservations.has(identifier))
			deliveredReplies += 1
		}
		return deliveredReplies
	})
}

export async function flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, port: browser.runtime.Port) {
	const socketIdentifier = websiteSocketToString(socket)
	if (websiteTabConnections.get(socket.tabId)?.connections[socketIdentifier]?.port !== port) return 0
	const existingRetry = terminalReplyFlushRetries.get(socketIdentifier)
	if (existingRetry !== undefined && existingRetry.port !== port) {
		existingRetry.scheduler.reset()
		terminalReplyFlushRetries.delete(socketIdentifier)
	}
	try {
		const deliveredReplies = await flushPendingTerminalRepliesForSocket(websiteTabConnections, socket)
		const retry = terminalReplyFlushRetries.get(socketIdentifier)
		if (retry?.port === port) {
			retry.scheduler.reset()
			terminalReplyFlushRetries.delete(socketIdentifier)
		}
		return deliveredReplies
	} catch (error) {
		await reportLocalRecovery(error, {
			source: 'pending_terminal_replies',
			code: 'pending_terminal_reply_socket_flush_failed',
			message: 'Retrying terminal reply delivery while the website connection remains active.',
		})
		if (websiteTabConnections.get(socket.tabId)?.connections[socketIdentifier]?.port !== port) return 0
		let retry = terminalReplyFlushRetries.get(socketIdentifier)
		if (retry === undefined) {
			retry = { port, scheduler: createBackoffRetryScheduler(50) }
			terminalReplyFlushRetries.set(socketIdentifier, retry)
		}
		const scheduledRetry = retry
		retry.scheduler.schedule(() => {
			if (terminalReplyFlushRetries.get(socketIdentifier) !== scheduledRetry) return
			const currentPort = websiteTabConnections.get(socket.tabId)?.connections[socketIdentifier]?.port
			if (currentPort !== port) {
				scheduledRetry.scheduler.reset()
				terminalReplyFlushRetries.delete(socketIdentifier)
				return
			}
			void flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, socket, port)
		})
		return 0
	}
}

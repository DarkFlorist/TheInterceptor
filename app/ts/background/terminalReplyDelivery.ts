import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { getUniqueRequestIdentifierString, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { appendPendingTerminalReplyWithPendingRequestDecision, getPendingTerminalReplies, removeDeliveredPendingTerminalReply, type TerminalReplyCompletion } from './pendingTerminalReplies.js'
import type { DecidePendingRequestInstance, PendingRequestInstance } from './pendingRequestDecisions.js'
import { createBackoffRetryScheduler } from '../utils/retryScheduler.js'

// A terminal reply is identified by its request id together with the pending request instance it answers, which its outbox entry records, as each instance gets at most one terminal reply: a reply to a new request under a reused id is never taken for an earlier one, and the same reply queued again, as the popup-close retry does, is still recognised as delivered. A reply stored before instance ids existed answers no known instance.
type TerminalReply = { readonly message: InterceptedRequestForward, readonly completes: TerminalReplyCompletion }
const terminalReplyKey = ({ message, completes }: TerminalReply) => JSON.stringify({ requestIdentifier: getUniqueRequestIdentifierString(message.uniqueRequestIdentifier), instanceId: completes.kind === 'pendingRequestInstance' ? completes.instanceId : undefined })

// Keyed by terminalReplyKey.
const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
const terminalReplyReservations = new Set<string>()
const completedTerminalReplies = new Set<string>()
// Taken before the pending-request storage lock, never inside it.
const terminalReplySemaphore = new Semaphore(1)
const terminalReplyFlushRetries = new Map<string, { port: browser.runtime.Port, scheduler: ReturnType<typeof createBackoffRetryScheduler> }>()

const completionOf = (instance: PendingRequestInstance): TerminalReplyCompletion => ({ kind: 'pendingRequestInstance', instanceId: instance.instanceId })

const removeDeliveredTerminalReply = async (reply: TerminalReply) => await removeDeliveredPendingTerminalReply(reply.message.uniqueRequestIdentifier, reply.completes)

async function finishPreviouslyDeliveredTerminalReply(reply: TerminalReply) {
	const key = terminalReplyKey(reply)
	if (!completedTerminalReplies.has(key)) return false
	await removeDeliveredTerminalReply(reply)
	completedTerminalReplies.delete(key)
	return true
}

// The completion marker is set before the outbox cleanup and cleared only after it succeeds, so a delivery whose cleanup failed is finished later without posting the reply again.
async function recordSuccessfulTerminalReplyDelivery(reply: TerminalReply, keepCompletionMarker: boolean) {
	const key = terminalReplyKey(reply)
	completedTerminalReplies.add(key)
	await removeDeliveredTerminalReply(reply)
	if (!keepCompletionMarker) completedTerminalReplies.delete(key)
}

// Queues the terminal reply in the same storage write as the decision on the pending request instance it answers. Whether a crash or a failed write comes before or after that write, the reply is queued exactly when the decision happened: a website is never answered for an instance that stayed pending, and an instance never leaves the queue with its reply lost. Waits for terminalReplySemaphore without holding the pending-request storage lock. The crash guarantee relies on a multi-key storage.local.set committing atomically, which current Chromium and Firefox do but neither documents.
export async function queueTerminalReplyWithPendingRequestDecision(message: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	const reply = { message, completes: completionOf(instance) }
	const key = terminalReplyKey(reply)
	terminalReplyReservations.add(key)
	try {
		const outcome = await terminalReplySemaphore.execute(async () => {
			const decided = await appendPendingTerminalReplyWithPendingRequestDecision(message, instance, decide)
			// Nothing was queued, so no delivery follows that would finish this reply, which a flush may have delivered from an earlier queueing while this reservation kept its completion marker.
			if (decided === 'unchanged') await finishPreviouslyDeliveredTerminalReply(reply)
			return decided
		})
		if (outcome === 'unchanged') terminalReplyReservations.delete(key)
		return outcome
	} catch (error) {
		terminalReplyReservations.delete(key)
		throw error
	}
}

// Delivers the reply queued for the pending request instance it answers.
export async function attemptQueuedTerminalReplyDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward, instance: PendingRequestInstance) {
	const reply = { message, completes: completionOf(instance) }
	const key = terminalReplyKey(reply)
	const existingProduction = terminalReplyProductions.get(key)
	if (existingProduction !== undefined) return await existingProduction
	const production = (async () => {
		const deliver = async () => await terminalReplySemaphore.execute(async () => {
			if (await finishPreviouslyDeliveredTerminalReply(reply)) return true
			const delivery = replyToInterceptedRequest(websiteTabConnections, message)
			if (delivery === true) await recordSuccessfulTerminalReplyDelivery(reply, false)
			return delivery
		})
		return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, deliver)
	})()
	terminalReplyProductions.set(key, production)
	try {
		return await production
	} finally {
		if (terminalReplyProductions.get(key) === production) terminalReplyProductions.delete(key)
		terminalReplyReservations.delete(key)
	}
}

export async function flushPendingTerminalRepliesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return await terminalReplySemaphore.execute(async () => {
		const pendingReplies = await getPendingTerminalReplies()
		let deliveredReplies = 0
		for (const { reply: message, completes } of pendingReplies) {
			const replySocket = message.uniqueRequestIdentifier.requestSocket
			if (replySocket.tabId !== socket.tabId || replySocket.connectionName !== socket.connectionName) continue
			const reply = { message, completes }
			const key = terminalReplyKey(reply)
			if (completedTerminalReplies.has(key)) {
				await removeDeliveredTerminalReply(reply)
				continue
			}
			if (replyToInterceptedRequest(websiteTabConnections, message) !== true) continue
			await recordSuccessfulTerminalReplyDelivery(reply, terminalReplyProductions.has(key) || terminalReplyReservations.has(key))
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

import type { PendingSafeProposalStore, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { appendPendingTerminalReply, getPendingTerminalReplies, writeSafeProposalReplyAndOutboxEntry, writeTerminalReplyUnlessDeferred, removePendingTerminalReply } from './pendingTerminalReplies.js'

const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
// A queued reply's reservation is owned by its producer: the reply object it queued. Only a successful queue write creates one, in the same critical section as the write, and only that producer, passing the same reply object, releases it; a queue attempt that queued nothing never touches another producer's reservation.
const terminalReplyReservations = new Map<string, InterceptedRequestForward>()

function reserveTerminalReply(producedReply: InterceptedRequestForward) {
	terminalReplyReservations.set(getUniqueRequestIdentifierString(producedReply.uniqueRequestIdentifier), producedReply)
}

function releaseOwnTerminalReplyReservation(producedReply: InterceptedRequestForward) {
	const identifier = getUniqueRequestIdentifierString(producedReply.uniqueRequestIdentifier)
	if (terminalReplyReservations.get(identifier) === producedReply) terminalReplyReservations.delete(identifier)
}
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

export async function queueTerminalReply(message: InterceptedRequestForward) {
	await terminalReplySemaphore.execute(async () => {
		await appendPendingTerminalReply(message)
		reserveTerminalReply(message)
	})
}

// Queues the website's proposal-hash reply and moves the signed proposal to the Safe proposal outbox in one write, reserving the reply like any other queued terminal reply.
export async function queueSafeProposalReplyAndMoveToOutbox(uniqueRequestIdentifier: InterceptedRequestForward['uniqueRequestIdentifier'], createStore: (pendingProposal: PendingTransactionOrSignableMessage) => PendingSafeProposalStore, message: InterceptedRequestForward) {
	return await terminalReplySemaphore.execute(async () => {
		const outcome = await writeSafeProposalReplyAndOutboxEntry(uniqueRequestIdentifier, createStore, message)
		if (outcome === 'moved') reserveTerminalReply(message)
		return outcome
	})
}

// The only way to queue a pending confirmation request's website reply: like queueTerminalReply, but marking the request answered in the same write and refusing while it holds a deferred Gnosis Safe signature other than `settledSignerReply`; only a reply actually queued is reserved.
export async function queueTerminalReplyUnlessDeferred(message: InterceptedRequestForward, settledSignerReply?: string) {
	return await terminalReplySemaphore.execute(async () => {
		const outcome = await writeTerminalReplyUnlessDeferred(message, settledSignerReply)
		if (outcome === 'queued') reserveTerminalReply(message)
		return outcome
	})
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
		releaseOwnTerminalReplyReservation(message)
	}
}

// Releases the producer's own reservation when it stops before attempting its delivery (its request removal failed), handing that delivery to the answered request's cleanup.
export function releaseTerminalReplyReservation(producedReply: InterceptedRequestForward) {
	releaseOwnTerminalReplyReservation(producedReply)
}

// Delivers the reply already queued for an answered request, if it is still queued; a reply formed later is never sent. While the flow that queued the reply still holds its reservation, that flow owns the delivery (and any completion marker a socket flush left for it), so this leaves the reply and its marker untouched.
export async function deliverQueuedTerminalReplyOnce(websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	const identifier = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const existingProduction = terminalReplyProductions.get(identifier)
	if (existingProduction !== undefined) return await existingProduction
	const findQueuedReply = async () => (await getPendingTerminalReplies()).find((reply) => doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier))
	const queuedReply = await findQueuedReply()
	if (queuedReply === undefined) return true
	const deliver = async () => await terminalReplySemaphore.execute(async () => {
		if (terminalReplyReservations.has(identifier) || terminalReplyProductions.has(identifier)) return true
		if (await finishPreviouslyDeliveredTerminalReply(identifier, queuedReply)) return true
		if (await findQueuedReply() === undefined) return true
		const delivery = replyToInterceptedRequest(websiteTabConnections, queuedReply)
		if (delivery === true) await recordSuccessfulTerminalReplyDelivery(identifier, queuedReply, false)
		return delivery
	})
	return await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, queuedReply, deliver)
}

// Delivers the reply a flow just queued. A request already answered (its removal failed after its reply was queued) is not answered again: only its own reply still waiting in the queue is delivered.
export async function deliverOwnQueuedTerminalReply(websiteTabConnections: WebsiteTabConnections, reply: InterceptedRequestForward, queued: 'queued' | 'already-answered') {
	if (queued === 'queued') return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, reply)
	return await deliverQueuedTerminalReplyOnce(websiteTabConnections, reply.uniqueRequestIdentifier)
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

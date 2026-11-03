import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { commitPendingTerminalReply, getPendingTerminalReplies, markPendingTerminalReplyDelivered, removePendingTerminalReply } from './pendingTerminalReplies.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
// Replies posted whose delivered mark is not stored yet: an attempt that finds one stores the mark instead of posting the reply again.
const postedUnmarkedTerminalReplies = new Set<string>()
const terminalReplySemaphore = new Semaphore(1)
const terminalReplyFlushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const TERMINAL_REPLY_FLUSH_RETRY_DELAY_MS = 50

// The size of the in-memory delivery bookkeeping, which is empty whenever no delivery is in flight.
export const getTerminalReplyBookkeepingSize = () => terminalReplyProductions.size + postedUnmarkedTerminalReplies.size

/**
 * The durable terminal-reply queue entry is a request's only commitment to its terminal reply. queueTerminalReply stores it once (a request that has one keeps it); a delivery by any path posts it at most once and marks it delivered, never deleting it while its request is pending; the entry is deleted last, once it is delivered and its request is no longer pending.
 */
export async function queueTerminalReply(message: InterceptedRequestForward) {
	return await terminalReplySemaphore.execute(async () => await commitPendingTerminalReply(message))
}

// The reply committed for the request.
export const getQueuedTerminalReply = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTerminalReplies()).find((reply) => doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier))

const isRequestPending = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages()).some((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

// Under the terminal-reply lock: deletes a delivered entry whose request is no longer pending.
async function retireIfFinished(entry: StoredTerminalReply) {
	if (entry.delivered !== true || await isRequestPending(entry.uniqueRequestIdentifier)) return
	await removePendingTerminalReply(entry.uniqueRequestIdentifier)
}

// Under the terminal-reply lock: posts the entry unless it was posted already, and marks it delivered. Whether it is delivered.
async function deliverEntry(websiteTabConnections: WebsiteTabConnections, entry: StoredTerminalReply) {
	const identifier = getUniqueRequestIdentifierString(entry.uniqueRequestIdentifier)
	if (entry.delivered !== true) {
		if (!postedUnmarkedTerminalReplies.has(identifier)) {
			const { delivered: _delivered, ...reply } = entry
			const delivery = replyToInterceptedRequest(websiteTabConnections, reply)
			if (delivery !== true) return delivery
			postedUnmarkedTerminalReplies.add(identifier)
		}
		await markPendingTerminalReplyDelivered(entry.uniqueRequestIdentifier)
		postedUnmarkedTerminalReplies.delete(identifier)
	}
	await retireIfFinished({ ...entry, delivered: true })
	return true
}

// Delivers the reply committed for the message's request, if it is not delivered yet. True when it is delivered, or there is none.
export async function attemptQueuedTerminalReplyDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	const identifier = getUniqueRequestIdentifierString(message.uniqueRequestIdentifier)
	const existingProduction = terminalReplyProductions.get(identifier)
	if (existingProduction !== undefined) return await existingProduction
	const deliver = async () => await terminalReplySemaphore.execute(async () => {
		const entry = await getQueuedTerminalReply(message.uniqueRequestIdentifier)
		return entry === undefined ? true : await deliverEntry(websiteTabConnections, entry)
	})
	const production = attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, deliver)
	terminalReplyProductions.set(identifier, production)
	try {
		return await production
	} finally {
		if (terminalReplyProductions.get(identifier) === production) terminalReplyProductions.delete(identifier)
	}
}

export async function queueTerminalReplyAndAttemptDelivery(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward) {
	await queueTerminalReply(message)
	return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, message)
}

// Deletes the request's entry once it is delivered and the request is no longer pending, the last step of finishing a request.
export async function retireDeliveredTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await terminalReplySemaphore.execute(async () => {
		const entry = await getQueuedTerminalReply(uniqueRequestIdentifier)
		if (entry !== undefined) await retireIfFinished(entry)
	})
}

// At startup: deletes the delivered entries whose requests a restart left finished but for deleting the entry.
export async function pruneDeliveredTerminalReplies() {
	await terminalReplySemaphore.execute(async () => {
		for (const entry of await getPendingTerminalReplies()) await retireIfFinished(entry)
	})
}

export async function flushPendingTerminalRepliesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return await terminalReplySemaphore.execute(async () => {
		let deliveredReplies = 0
		for (const entry of await getPendingTerminalReplies()) {
			const replySocket = entry.uniqueRequestIdentifier.requestSocket
			if (replySocket.tabId !== socket.tabId || replySocket.connectionName !== socket.connectionName) continue
			const newlyDelivered = entry.delivered !== true && !postedUnmarkedTerminalReplies.has(getUniqueRequestIdentifierString(entry.uniqueRequestIdentifier))
			if (await deliverEntry(websiteTabConnections, entry) === true && newlyDelivered) deliveredReplies += 1
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

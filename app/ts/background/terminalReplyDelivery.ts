import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { commitPendingTerminalReply, forgetPendingTerminalReplyWindow, getPendingTerminalReplies, markPendingTerminalReplyDelivered, rememberPendingTerminalReplyWindow, removePendingTerminalReply } from './pendingTerminalReplies.js'
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
 * The durable terminal-reply queue entry is a request's only commitment to its terminal reply. queueTerminalReply stores it once (a request that has one keeps it); a delivery by any path, the resolution or a reconnect flush, posts it and marks it delivered, never deleting it while its request is pending; the entry is deleted last, once it is delivered and its request is no longer pending.
 * Within a session a reply is posted once. A restart between posting it and storing its delivered mark posts it again; the page's provider ignores a reply to a request it has already settled or does not know, so the page still settles the request once.
 */
export async function queueTerminalReply(message: InterceptedRequestForward, confirmationWindow?: PopupOrTabId) {
	return await terminalReplySemaphore.execute(async () => await commitPendingTerminalReply(confirmationWindow === undefined ? message : { ...message, confirmationWindow }))
}

// The reply committed for the request.
export const getQueuedTerminalReply = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTerminalReplies()).find((reply) => doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier))

const isRequestPending = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => (await getPendingTransactionsAndMessages()).some((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))

// Under the terminal-reply lock: posts the entry unless it was posted already, and marks it delivered. Whether it is delivered.
async function deliverEntry(websiteTabConnections: WebsiteTabConnections, entry: StoredTerminalReply) {
	const identifier = getUniqueRequestIdentifierString(entry.uniqueRequestIdentifier)
	if (entry.delivered !== true) {
		if (!postedUnmarkedTerminalReplies.has(identifier)) {
			const { delivered: _delivered, confirmationWindow: _confirmationWindow, ...reply } = entry
			const delivery = replyToInterceptedRequest(websiteTabConnections, reply)
			if (delivery !== true) return delivery
			postedUnmarkedTerminalReplies.add(identifier)
		}
		await markPendingTerminalReplyDelivered(entry.uniqueRequestIdentifier)
		postedUnmarkedTerminalReplies.delete(identifier)
	}
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

// The routine that finishes a committed request (finishCommittedRequest), registered by the background; a flush runs it for the requests whose replies it delivered.
type CommittedRequestFinisher = (uniqueRequestIdentifier: UniqueRequestIdentifier, websiteTabConnections: WebsiteTabConnections) => Promise<unknown>
let committedRequestFinisher: CommittedRequestFinisher | undefined
export const setCommittedRequestFinisher = (finisher: CommittedRequestFinisher) => { committedRequestFinisher = finisher }

// Records the window that shows the entry's request, unless the entry has one, under the terminal-reply lock.
export async function attachTerminalReplyWindow(uniqueRequestIdentifier: UniqueRequestIdentifier, confirmationWindow: PopupOrTabId) {
	await terminalReplySemaphore.execute(async () => {
		if ((await getQueuedTerminalReply(uniqueRequestIdentifier))?.confirmationWindow === undefined) await rememberPendingTerminalReplyWindow(uniqueRequestIdentifier, confirmationWindow)
	})
}

export async function forgetTerminalReplyWindow(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await terminalReplySemaphore.execute(async () => await forgetPendingTerminalReplyWindow(uniqueRequestIdentifier))
}

// The last step of finishing a request, and the only deletion of an entry: under the terminal-reply lock, it deletes the stored entry once it is delivered (or its requesting tab is gone, so it cannot be), its window was updated, and its request is no longer pending.
export async function retireTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier, requestingTabGone: boolean) {
	await terminalReplySemaphore.execute(async () => {
		const entry = await getQueuedTerminalReply(uniqueRequestIdentifier)
		if (entry === undefined || (entry.delivered !== true && !requestingTabGone) || entry.confirmationWindow !== undefined || await isRequestPending(uniqueRequestIdentifier)) return
		await removePendingTerminalReply(uniqueRequestIdentifier)
	})
}

// Delivers the socket's undelivered replies, then finishes their requests (setCommittedRequestFinisher), which is what deletes a delivered entry.
export async function flushPendingTerminalRepliesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const { deliveredReplies, delivered } = await terminalReplySemaphore.execute(async () => {
		let deliveredReplies = 0
		const delivered: UniqueRequestIdentifier[] = []
		for (const entry of await getPendingTerminalReplies()) {
			const replySocket = entry.uniqueRequestIdentifier.requestSocket
			if (replySocket.tabId !== socket.tabId || replySocket.connectionName !== socket.connectionName) continue
			const newlyDelivered = entry.delivered !== true && !postedUnmarkedTerminalReplies.has(getUniqueRequestIdentifierString(entry.uniqueRequestIdentifier))
			if (await deliverEntry(websiteTabConnections, entry) !== true) continue
			delivered.push(entry.uniqueRequestIdentifier)
			if (newlyDelivered) deliveredReplies += 1
		}
		return { deliveredReplies, delivered }
	})
	if (committedRequestFinisher === undefined) {
		if (delivered.length > 0) await reportLocalRecovery(new Error('No committed request finisher is registered'), { source: 'pending_terminal_replies', code: 'committed_request_finisher_missing', message: 'Delivered terminal replies stay queued until startup finishes their requests.' })
		return deliveredReplies
	}
	for (const uniqueRequestIdentifier of delivered) await committedRequestFinisher(uniqueRequestIdentifier, websiteTabConnections)
	return deliveredReplies
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

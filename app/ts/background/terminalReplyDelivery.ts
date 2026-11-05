import type { InterceptedRequestForward, StoredTerminalReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { createBoundedRetries } from '../utils/boundedRetry.js'
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
// Each connected socket's flush retries.
const terminalReplyFlushRetries = createBoundedRetries<string>({ baseDelayMs: 50, attemptLimit: 6 })

// The size of the in-memory delivery bookkeeping, which is empty whenever no delivery is in flight.
export const getTerminalReplyBookkeepingSize = () => terminalReplyProductions.size + postedUnmarkedTerminalReplies.size + terminalReplyFlushRetries.getScheduledRetryCount()

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

// Finishes a committed request (requestResolution.ts), which is what deletes a delivered entry: a flush is given it by its caller, the composition root.
export type CommittedRequestFinisher = (uniqueRequestIdentifier: UniqueRequestIdentifier, websiteTabConnections: WebsiteTabConnections) => Promise<unknown>

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
		// A reply retired undelivered, because its tab is gone, may have been posted without its delivered mark: its posted marker goes with the entry. Coalesced delivery attempts (terminalReplyProductions) clear themselves when they settle.
		postedUnmarkedTerminalReplies.delete(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
	})
}

// Delivers the socket's undelivered replies, then finishes their requests with the given finisher.
export async function flushPendingTerminalRepliesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, finishCommittedRequest: CommittedRequestFinisher) {
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
	for (const uniqueRequestIdentifier of delivered) await finishCommittedRequest(uniqueRequestIdentifier, websiteTabConnections)
	return deliveredReplies
}

// Flushes a newly connected port's replies, the external trigger that gives the connection a new retry budget: a failed flush is retried with backoff (50 ms, doubling) while the same port stays connected, up to a limit, then reported as given up until the port reconnects.
export async function flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, port: browser.runtime.Port, finishCommittedRequest: CommittedRequestFinisher) {
	terminalReplyFlushRetries.reset(websiteSocketToString(socket))
	return await flushConnectedPort(websiteTabConnections, socket, port, finishCommittedRequest)
}

async function flushConnectedPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, port: browser.runtime.Port, finishCommittedRequest: CommittedRequestFinisher): Promise<number> {
	const socketIdentifier = websiteSocketToString(socket)
	try {
		const deliveredReplies = await flushPendingTerminalRepliesForSocket(websiteTabConnections, socket, finishCommittedRequest)
		terminalReplyFlushRetries.reset(socketIdentifier)
		return deliveredReplies
	} catch (error) {
		await terminalReplyFlushRetries.retryAfterFailure(socketIdentifier, () => {
			if (websiteTabConnections.get(socket.tabId)?.connections[socketIdentifier]?.port === port) void flushConnectedPort(websiteTabConnections, socket, port, finishCommittedRequest)
		}, async (retrying) => await reportLocalRecovery(error, retrying
			? { source: 'pending_terminal_replies', code: 'pending_terminal_reply_socket_flush_failed', message: 'Retrying terminal reply delivery while the website connection remains active.' }
			: { source: 'pending_terminal_replies', code: 'pending_terminal_reply_socket_flush_gave_up', message: 'Stopped retrying terminal reply delivery until the website connection reconnects.' }))
		return 0
	}
}

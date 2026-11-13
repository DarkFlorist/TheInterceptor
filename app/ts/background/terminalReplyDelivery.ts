import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type WebsiteSocket } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { appendPendingTerminalReplyWithPendingRequestDecision, getPendingTerminalReplies, removePendingTerminalReply, removePendingTerminalReplyWithAnsweredRequest } from './pendingTerminalReplies.js'
import type { DecidePendingRequestInstance, PendingRequestInstance } from './pendingRequestDecisions.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

// A terminal reply is identified by its request id together with the pending request instance it answers, as each instance gets at most one terminal reply: a reply to a new request under a reused id is never taken for an earlier one, and the same reply queued again, as the popup-close retry does, is still recognised as delivered. A reply queued before a restart whose request already left the queue has no known instance.
type TerminalReply = { readonly message: InterceptedRequestForward, readonly instanceId: string | undefined }
const terminalReplyKey = ({ message, instanceId }: TerminalReply) => JSON.stringify({ requestIdentifier: getUniqueRequestIdentifierString(message.uniqueRequestIdentifier), instanceId })

// Keyed by terminalReplyKey.
const terminalReplyProductions = new Map<string, Promise<boolean | undefined>>()
const terminalReplyReservations = new Set<string>()
const completedTerminalReplies = new Set<string>()
// The pending request instance whose reply this background last queued under each request id, which is the reply the outbox holds under that id.
const queuedTerminalReplyInstanceIds = new Map<string, string>()
const terminalReplySemaphore = new Semaphore(1)
const terminalReplyFlushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const TERMINAL_REPLY_FLUSH_RETRY_DELAY_MS = 50

// Only a popup-close rejection keeps its request pending until it is delivered, marked ClosedWithoutResponse; every other terminal reply removes its request in the storage write that queues the reply. Read from storage, so a delivery after a restart finds it too.
const findRequestAwaitingDelivery = async (message: InterceptedRequestForward) => (await getPendingTransactionsAndMessages()).find((pending) => pending.approvalStatus.status === 'ClosedWithoutResponse' && doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, message.uniqueRequestIdentifier))

// The instance whose reply the outbox holds under a request id: the one this background last queued there, else, for a reply queued before a restart, the popup-close request still awaiting it.
const getQueuedTerminalReplyInstanceId = (identifier: string, requestAwaitingDelivery: PendingRequestInstance | undefined) => queuedTerminalReplyInstanceIds.get(identifier) ?? requestAwaitingDelivery?.instanceId

async function identifyQueuedTerminalReply(message: InterceptedRequestForward): Promise<TerminalReply> {
	return { message, instanceId: getQueuedTerminalReplyInstanceId(getUniqueRequestIdentifierString(message.uniqueRequestIdentifier), await findRequestAwaitingDelivery(message)) }
}

// Drops a delivered reply from the outbox and, in the same storage write, the request still awaiting it, so every delivery path, including a flush after a restart, leaves neither behind. A reply to a new request under the same id that has since replaced it in the outbox is kept, with its request.
async function removeDeliveredTerminalReply(reply: TerminalReply) {
	const identifier = getUniqueRequestIdentifierString(reply.message.uniqueRequestIdentifier)
	const requestAwaitingDelivery = await findRequestAwaitingDelivery(reply.message)
	if (getQueuedTerminalReplyInstanceId(identifier, requestAwaitingDelivery) !== reply.instanceId) return
	if (requestAwaitingDelivery === undefined || requestAwaitingDelivery.instanceId !== reply.instanceId) await removePendingTerminalReply(reply.message.uniqueRequestIdentifier)
	else await removePendingTerminalReplyWithAnsweredRequest(reply.message.uniqueRequestIdentifier, requestAwaitingDelivery)
	queuedTerminalReplyInstanceIds.delete(identifier)
}

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

// Queues the terminal reply in the same storage write as the decision on the pending request instance it answers. Whether a crash or a failed write comes before or after that write, the reply is queued exactly when the decision happened: a website is never answered for an instance that stayed pending, and an instance never leaves the queue with its reply lost. Waits for terminalReplySemaphore without holding the pending-request lock. The crash guarantee relies on a multi-key storage.local.set committing atomically, which current Chromium and Firefox do but neither documents.
export async function queueTerminalReplyWithPendingRequestDecision(message: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	const reply = { message, instanceId: instance.instanceId }
	const key = terminalReplyKey(reply)
	terminalReplyReservations.add(key)
	try {
		const outcome = await terminalReplySemaphore.execute(async () => {
			const decided = await appendPendingTerminalReplyWithPendingRequestDecision(message, instance, decide)
			// Nothing was queued, so no delivery follows that would finish this reply, which a flush may have delivered from an earlier queueing while this reservation kept its completion marker.
			if (decided === 'unchanged') await finishPreviouslyDeliveredTerminalReply(reply)
			else queuedTerminalReplyInstanceIds.set(getUniqueRequestIdentifierString(message.uniqueRequestIdentifier), instance.instanceId)
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
	const reply = { message, instanceId: instance.instanceId }
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
		for (const message of pendingReplies) {
			const replySocket = message.uniqueRequestIdentifier.requestSocket
			if (replySocket.tabId !== socket.tabId || replySocket.connectionName !== socket.connectionName) continue
			const reply = await identifyQueuedTerminalReply(message)
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

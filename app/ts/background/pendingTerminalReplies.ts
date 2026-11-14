import type { PendingSafeProposalStore, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { movePendingSafeProposalToOutbox, queueTerminalRepliesUnlessDeferred } from './storageVariables.js'
import { pendingRequestTerminalStateSemaphore } from './terminalStateSemaphore.js'

export async function getPendingTerminalReplies(): Promise<readonly InterceptedRequestForward[]> {
	const parsedStorage = await browserStorageLocalSafeParseGet('pendingTerminalReplies')
	if (parsedStorage !== undefined) return parsedStorage.pendingTerminalReplies ?? []
	const validationError = new Error('Stored pending terminal replies failed runtime validation.')
	await browserStorageLocalSet({ pendingTerminalReplies: [] })
	await reportLocalRecovery(validationError, {
		source: 'pending_terminal_replies',
		code: 'pending_terminal_replies_corrupt',
		message: 'Discarded corrupt pending terminal replies so wallet requests can continue.',
	})
	return []
}

async function updatePendingTerminalReplies(update: (pendingReplies: readonly InterceptedRequestForward[]) => readonly InterceptedRequestForward[]) {
	return await pendingRequestTerminalStateSemaphore.execute(async () => {
		const pendingTerminalReplies = update(await getPendingTerminalReplies())
		await browserStorageLocalSet({ pendingTerminalReplies })
		return pendingTerminalReplies
	})
}

export async function appendPendingTerminalReply(reply: InterceptedRequestForward) {
	await updatePendingTerminalReplies((pendingReplies) => [
		...pendingReplies.filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier)),
		reply,
	])
}

const withTerminalReply = (reply: InterceptedRequestForward) => async () => [...(await getPendingTerminalReplies()).filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier)), reply]

// Queues the website's proposal-hash reply together with moving the signed proposal from the pending queue to the Safe proposal outbox, unless the request is already answered.
export async function writeSafeProposalReplyAndOutboxEntry(
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	createStore: (pendingProposal: PendingTransactionOrSignableMessage) => PendingSafeProposalStore,
	reply: InterceptedRequestForward,
) {
	return await movePendingSafeProposalToOutbox(uniqueRequestIdentifier, createStore, withTerminalReply(reply), true)
}

// Queues a pending request's website reply unless the request holds a deferred Gnosis Safe signature this reply does not settle.
export async function writeTerminalReplyUnlessDeferred(reply: InterceptedRequestForward, settledSignerReply?: string) {
	return await queueTerminalRepliesUnlessDeferred(reply.uniqueRequestIdentifier, withTerminalReply(reply), settledSignerReply)
}

export async function removePendingTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((reply) => !doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier)))
}

export async function removePendingTerminalRepliesForTab(tabId: number) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((reply) => reply.uniqueRequestIdentifier.requestSocket.tabId !== tabId))
}

export async function prunePendingTerminalRepliesForMissingTabs() {
	const pendingReplies = await getPendingTerminalReplies()
	const tabIds = [...new Set(pendingReplies.map((reply) => reply.uniqueRequestIdentifier.requestSocket.tabId))]
	const missingTabIds = new Set<number>()
	for (const tabId of tabIds) {
		if (!await doesTabExist(tabId)) missingTabIds.add(tabId)
	}
	if (missingTabIds.size === 0) return 0
	const remainingReplies = await updatePendingTerminalReplies((replies) => replies.filter((reply) => !missingTabIds.has(reply.uniqueRequestIdentifier.requestSocket.tabId)))
	return pendingReplies.length - remainingReplies.length
}

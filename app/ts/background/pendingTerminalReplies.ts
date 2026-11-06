import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet, browserStorageLocalSetTerminalRepliesWithPendingRequests } from '../utils/storageUtils.js'
import { applyPendingRequestInstanceDecision, type DecidePendingRequestInstance, type PendingRequestInstance } from './storageVariables.js'

const pendingTerminalRepliesSemaphore = new Semaphore(1)

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
	return await pendingTerminalRepliesSemaphore.execute(async () => {
		const pendingTerminalReplies = update(await getPendingTerminalReplies())
		await browserStorageLocalSet({ pendingTerminalReplies })
		return pendingTerminalReplies
	})
}

// Stores the reply and the decision on the pending request instance it answers in one storage write, and neither when the decision leaves the instance 'unchanged'. This module owns the outbox key, so it holds the outbox lock and builds that write itself; the pending-request side only computes the new pending requests. The outbox is read before the pending-request lock is taken, so that lock only spans its own read and the write.
export async function appendPendingTerminalReplyWithPendingRequestDecision(reply: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	return await pendingTerminalRepliesSemaphore.execute(async () => {
		const otherReplies = (await getPendingTerminalReplies()).filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier))
		const pendingTerminalReplies = [...otherReplies, reply]
		// This module writes the pending-requests key here because this is the one write that has to commit a reply and its decision together, and the pending-request lock stays private to storageVariables.ts, so the write runs there as an injected write.
		return await applyPendingRequestInstanceDecision(instance, decide, async (pendingTransactionsAndMessages) => {
			await browserStorageLocalSetTerminalRepliesWithPendingRequests(pendingTerminalReplies, pendingTransactionsAndMessages)
		})
	})
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

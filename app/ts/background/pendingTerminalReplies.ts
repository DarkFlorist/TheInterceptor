import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSafeParseGet, browserStorageLocalSet, pendingTerminalRepliesWriteBrand } from '../utils/storageUtils.js'
import { type DecidePendingRequestInstance, type PendingRequestInstance, writePendingRequestsWithTerminalReplies } from './pendingRequestDecisions.js'

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

// Stores the reply and the decision on the pending request instance it answers in one storage write, and neither when the decision leaves the instance 'unchanged'. This module decides the outbox's contents under its lock; storageVariables.ts makes the write because the pending-request lock is private to it. The outbox is read before that lock is taken, so that lock only spans its own read and the write.
export async function appendPendingTerminalReplyWithPendingRequestDecision(reply: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	return await pendingTerminalRepliesSemaphore.execute(async () => {
		const otherReplies = (await getPendingTerminalReplies()).filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier))
		return await writePendingRequestsWithTerminalReplies({ [pendingTerminalRepliesWriteBrand]: true, pendingTerminalReplies: [...otherReplies, reply] }, instance, decide)
	})
}

// Removes a delivered reply from the outbox and the request still awaiting it, while that request is still ClosedWithoutResponse, in one storage write, so a failure leaves both and a retry finds the reply delivered instead of posting it again. Once the request is gone, only the reply is removed.
export async function removePendingTerminalReplyWithAnsweredRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, answeredRequest: PendingRequestInstance) {
	await pendingTerminalRepliesSemaphore.execute(async () => {
		const pendingTerminalReplies = (await getPendingTerminalReplies()).filter((reply) => !doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier))
		const outcome = await writePendingRequestsWithTerminalReplies({ [pendingTerminalRepliesWriteBrand]: true, pendingTerminalReplies }, answeredRequest, (current) => current.approvalStatus.status === 'ClosedWithoutResponse' ? { type: 'remove' } : undefined)
		if (outcome === 'unchanged') await browserStorageLocalSet({ pendingTerminalReplies })
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

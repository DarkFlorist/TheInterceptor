import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { serialize } from '../types/wire-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { browserStorageLocalSafeParseGet, type QueuedTerminalReply, StoredPendingTerminalReplies } from '../utils/storageUtils.js'
import { type DecidePendingRequestInstance, decidePendingRequestInstance, type PendingRequestInstance, type PendingRequestInstanceOutcome } from './pendingRequestDecisions.js'
import { type PendingRequestStorageWrite, runPendingRequestStorageTransaction } from './pendingRequestStorageTransaction.js'
import { pendingRequestsStorageWrite, readPendingRequestsInTransaction } from './storageVariables.js'

// This module owns the reply outbox key and its storage format; every write of it is a write of runPendingRequestStorageTransaction built by outboxStorageWrite.
const outboxStorageWrite = (pendingTerminalReplies: readonly QueuedTerminalReply[]): PendingRequestStorageWrite => ({ pendingTerminalReplies: serialize(StoredPendingTerminalReplies, pendingTerminalReplies) })

const withoutReplyTo = (pendingTerminalReplies: readonly QueuedTerminalReply[], uniqueRequestIdentifier: UniqueRequestIdentifier) => pendingTerminalReplies.filter((entry) => !doesUniqueRequestIdentifiersMatch(entry.reply.uniqueRequestIdentifier, uniqueRequestIdentifier))

export async function getPendingTerminalReplies(): Promise<readonly QueuedTerminalReply[]> {
	const parsedStorage = await browserStorageLocalSafeParseGet('pendingTerminalReplies')
	if (parsedStorage !== undefined) return parsedStorage.pendingTerminalReplies ?? []
	const validationError = new Error('Stored pending terminal replies failed runtime validation.')
	await browser.storage.local.set(outboxStorageWrite([]))
	await reportLocalRecovery(validationError, {
		source: 'pending_terminal_replies',
		code: 'pending_terminal_replies_corrupt',
		message: 'Discarded corrupt pending terminal replies so wallet requests can continue.',
	})
	return []
}

async function updatePendingTerminalReplies(update: (pendingReplies: readonly QueuedTerminalReply[]) => readonly QueuedTerminalReply[]) {
	return await runPendingRequestStorageTransaction(async () => {
		const pendingTerminalReplies = update(await getPendingTerminalReplies())
		return { writes: [outboxStorageWrite(pendingTerminalReplies)], result: pendingTerminalReplies }
	})
}

// Queues the reply for the pending request instance it answers in the same storage write as the decision on that instance, and neither when the decision leaves the instance 'unchanged'. The entry records the instance, so a later delivery, also after a restart, completes only that instance. A queued reply replaces any earlier one under the same request id.
export async function appendPendingTerminalReplyWithPendingRequestDecision(reply: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance): Promise<PendingRequestInstanceOutcome> {
	return await runPendingRequestStorageTransaction(async () => {
		const decided = decidePendingRequestInstance(await readPendingRequestsInTransaction(), instance, decide)
		if (decided.outcome === 'unchanged') return { writes: [], result: decided.outcome }
		const pendingTerminalReplies = [...withoutReplyTo(await getPendingTerminalReplies(), reply.uniqueRequestIdentifier), { reply, answeredInstanceId: instance.instanceId }]
		return { writes: [pendingRequestsStorageWrite(decided.pendingTransactionsOrMessages), outboxStorageWrite(pendingTerminalReplies)], result: decided.outcome }
	})
}

// Removes a delivered reply from the outbox, together with the request instance still waiting for it (a popup-close rejection keeps its request ClosedWithoutResponse until delivered) in the same storage write, so a failure leaves both and a retry finds the reply delivered instead of posting it again. Does nothing when the outbox now holds a reply to another instance under that request id, which a newer request queued.
export async function removeDeliveredPendingTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier, answeredInstanceId: string | undefined) {
	await runPendingRequestStorageTransaction(async () => {
		const queued = await getPendingTerminalReplies()
		const delivered = queued.find((entry) => doesUniqueRequestIdentifiersMatch(entry.reply.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (delivered === undefined || delivered.answeredInstanceId !== answeredInstanceId) return { writes: [], result: undefined }
		const outboxWrite = outboxStorageWrite(withoutReplyTo(queued, uniqueRequestIdentifier))
		if (answeredInstanceId === undefined) return { writes: [outboxWrite], result: undefined }
		const decided = decidePendingRequestInstance(await readPendingRequestsInTransaction(), { uniqueRequestIdentifier, instanceId: answeredInstanceId }, (current) => current.approvalStatus.status === 'ClosedWithoutResponse' ? { type: 'remove' } : undefined)
		return { writes: decided.outcome === 'unchanged' ? [outboxWrite] : [pendingRequestsStorageWrite(decided.pendingTransactionsOrMessages), outboxWrite], result: undefined }
	})
}

export async function removePendingTerminalRepliesForTab(tabId: number) {
	await updatePendingTerminalReplies((pendingReplies) => pendingReplies.filter((entry) => entry.reply.uniqueRequestIdentifier.requestSocket.tabId !== tabId))
}

export async function prunePendingTerminalRepliesForMissingTabs() {
	const pendingReplies = await getPendingTerminalReplies()
	const tabIds = [...new Set(pendingReplies.map((entry) => entry.reply.uniqueRequestIdentifier.requestSocket.tabId))]
	const missingTabIds = new Set<number>()
	for (const tabId of tabIds) {
		if (!await doesTabExist(tabId)) missingTabIds.add(tabId)
	}
	if (missingTabIds.size === 0) return 0
	const remainingReplies = await updatePendingTerminalReplies((replies) => replies.filter((entry) => !missingTabIds.has(entry.reply.uniqueRequestIdentifier.requestSocket.tabId)))
	return pendingReplies.length - remainingReplies.length
}

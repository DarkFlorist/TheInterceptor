import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { serialize } from '../types/wire-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSafeParseGet, type PendingTerminalRepliesWrite, pendingTerminalRepliesWriteBrand, StoredPendingTerminalReplies } from '../utils/storageUtils.js'
import { type DecidePendingRequestInstance, type PendingRequestInstance, writePendingRequestsWithTerminalReplies } from './pendingRequestDecisions.js'

const pendingTerminalRepliesSemaphore = new Semaphore(1)

// The outbox's storage items. Every write of the outbox key, alone or with the pending requests, stores these, so its storage format has one owner.
const toOutboxStorageItems = (pendingTerminalReplies: readonly InterceptedRequestForward[]) => ({ pendingTerminalReplies: serialize(StoredPendingTerminalReplies, pendingTerminalReplies) })
const writeOutbox = async (pendingTerminalReplies: readonly InterceptedRequestForward[]) => { await browser.storage.local.set(toOutboxStorageItems(pendingTerminalReplies)) }

export async function getPendingTerminalReplies(): Promise<readonly InterceptedRequestForward[]> {
	const parsedStorage = await browserStorageLocalSafeParseGet('pendingTerminalReplies')
	if (parsedStorage !== undefined) return parsedStorage.pendingTerminalReplies ?? []
	const validationError = new Error('Stored pending terminal replies failed runtime validation.')
	await writeOutbox([])
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
		await writeOutbox(pendingTerminalReplies)
		return pendingTerminalReplies
	})
}

// Runs work under the outbox lock with the outbox as stored now. leaseWrite turns an outbox derived from that read into the write storageVariables.ts stores with the pending requests; the lease is valid only until this lock is released.
async function withOutboxWriteLease<T>(work: (current: readonly InterceptedRequestForward[], leaseWrite: (next: readonly InterceptedRequestForward[]) => PendingTerminalRepliesWrite) => Promise<T>) {
	return await pendingTerminalRepliesSemaphore.execute(async () => {
		let outboxLockHeld = true
		try {
			const leaseWrite = (next: readonly InterceptedRequestForward[]): PendingTerminalRepliesWrite => ({ [pendingTerminalRepliesWriteBrand]: true, storageItems: toOutboxStorageItems(next), isOutboxLockHeld: () => outboxLockHeld })
			return await work(await getPendingTerminalReplies(), leaseWrite)
		} finally {
			outboxLockHeld = false
		}
	})
}

// Stores the reply and the decision on the pending request instance it answers in one storage write, and neither when the decision leaves the instance 'unchanged'. This module decides and serializes the outbox under its lock; storageVariables.ts makes the write because the pending-request lock is private to it. The outbox is read before that lock is taken, so that lock only spans its own read and the write.
export async function appendPendingTerminalReplyWithPendingRequestDecision(reply: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	return await withOutboxWriteLease(async (current, leaseWrite) => {
		const otherReplies = current.filter((pendingReply) => !doesUniqueRequestIdentifiersMatch(pendingReply.uniqueRequestIdentifier, reply.uniqueRequestIdentifier))
		return await writePendingRequestsWithTerminalReplies(leaseWrite([...otherReplies, reply]), instance, decide)
	})
}

// Removes a delivered reply from the outbox and the request still awaiting it, while that request is still ClosedWithoutResponse, in one storage write, so a failure leaves both and a retry finds the reply delivered instead of posting it again. Once the request is gone, only the reply is removed.
export async function removePendingTerminalReplyWithAnsweredRequest(uniqueRequestIdentifier: UniqueRequestIdentifier, answeredRequest: PendingRequestInstance) {
	await withOutboxWriteLease(async (current, leaseWrite) => {
		const pendingTerminalReplies = current.filter((reply) => !doesUniqueRequestIdentifiersMatch(reply.uniqueRequestIdentifier, uniqueRequestIdentifier))
		const outcome = await writePendingRequestsWithTerminalReplies(leaseWrite(pendingTerminalReplies), answeredRequest, (current) => current.approvalStatus.status === 'ClosedWithoutResponse' ? { type: 'remove' } : undefined)
		if (outcome === 'unchanged') await writeOutbox(pendingTerminalReplies)
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

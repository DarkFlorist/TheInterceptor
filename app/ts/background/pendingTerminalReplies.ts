import * as funtypes from 'funtypes'
import { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { serialize } from '../types/wire-types.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { doesTabExist, doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { type DecidePendingRequestInstance, decidePendingRequestInstance, type PendingRequestInstance, type PendingRequestInstanceOutcome } from './pendingRequestDecisions.js'
import { type PendingRequestStorageWrite, runPendingRequestStorageTransaction } from './pendingRequestStorageTransaction.js'
import { pendingRequestsStorageWrite, readPendingRequestsInTransaction } from './storageVariables.js'

// This module owns the reply outbox key: its codec is private and the generic storage codecs leave the key out, so every read goes through this module and every write is a write of runPendingRequestStorageTransaction built by outboxStorageWrite.

// What delivering a queued terminal reply completes: the pending request instance it answers, or no pending request, for a reply stored before instance ids existed.
export type TerminalReplyCompletion = { readonly kind: 'pendingRequestInstance', readonly instanceId: string } | { readonly kind: 'noPendingRequest' }

// A terminal reply waiting in the outbox for the page, with what its delivery completes.
export type QueuedTerminalReply = { readonly reply: InterceptedRequestForward, readonly completes: TerminalReplyCompletion }

const isSameTerminalReplyCompletion = (first: TerminalReplyCompletion, second: TerminalReplyCompletion) => first.kind === 'pendingRequestInstance' ? second.kind === 'pendingRequestInstance' && first.instanceId === second.instanceId : second.kind === 'noPendingRequest'

// A stored outbox entry: a terminal reply and the id of the pending request instance it answers, stored together so delivery after a restart still knows which request the reply completes.
const StoredTerminalReplyEntry = funtypes.ReadonlyObject({ reply: InterceptedRequestForward, answeredInstanceId: funtypes.String })
// Entries stored before instance ids existed are bare replies. That version removed a request in the write after queueing its reply and had no popup-close state that kept a request waiting for its reply, so such a reply answers no request still pending: it parses as answering no instance, is delivered, and is then removed from the outbox alone.
const LegacyStoredTerminalReply = InterceptedRequestForward.withParser({
	parse: (reply) => ({ success: true, value: { reply, answeredInstanceId: undefined } }),
	// A withParser serializer returns the underlying runtype's parsed value, which funtypes then serializes with InterceptedRequestForward itself, so the reply is stored in its wire form (storedPendingTerminalReplies.test.ts rewrites a legacy entry and reads it back).
	serialize: (entry: { readonly reply: InterceptedRequestForward, readonly answeredInstanceId: undefined }) => ({ success: true, value: entry.reply }),
})
type StoredTerminalReply = funtypes.Static<typeof StoredTerminalReply>
const StoredTerminalReply = funtypes.Union(StoredTerminalReplyEntry, LegacyStoredTerminalReply)
// The outbox's stored form. Exported only for the storage-format test.
export const StoredPendingTerminalReplies = funtypes.ReadonlyArray(StoredTerminalReply)
const StoredOutboxItems = funtypes.ReadonlyPartial({ pendingTerminalReplies: StoredPendingTerminalReplies })

const fromStoredTerminalReply = ({ reply, answeredInstanceId }: StoredTerminalReply): QueuedTerminalReply => ({ reply, completes: answeredInstanceId === undefined ? { kind: 'noPendingRequest' } : { kind: 'pendingRequestInstance', instanceId: answeredInstanceId } })
const toStoredTerminalReply = ({ reply, completes }: QueuedTerminalReply): StoredTerminalReply => completes.kind === 'pendingRequestInstance' ? { reply, answeredInstanceId: completes.instanceId } : { reply, answeredInstanceId: undefined }

const outboxStorageWrite = (pendingTerminalReplies: readonly QueuedTerminalReply[]): PendingRequestStorageWrite => {
	const storedPendingTerminalReplies: funtypes.Static<typeof StoredPendingTerminalReplies> = pendingTerminalReplies.map(toStoredTerminalReply)
	return { pendingTerminalReplies: serialize(StoredPendingTerminalReplies, storedPendingTerminalReplies) }
}

const withoutReplyTo = (pendingTerminalReplies: readonly QueuedTerminalReply[], uniqueRequestIdentifier: UniqueRequestIdentifier) => pendingTerminalReplies.filter((entry) => !doesUniqueRequestIdentifiersMatch(entry.reply.uniqueRequestIdentifier, uniqueRequestIdentifier))

// The outbox as stored, or undefined when the stored data does not parse. A failing storage read still throws.
async function parseStoredOutbox() {
	const parsed = StoredOutboxItems.safeParse(await browser.storage.local.get(['pendingTerminalReplies']))
	if (!parsed.success) return undefined
	return (parsed.value.pendingTerminalReplies ?? []).map(fromStoredTerminalReply)
}

// Reads the outbox for a plan of runPendingRequestStorageTransaction, which must already hold its lock, so a corrupt outbox is replaced with an empty one only while no transaction can queue a reply in between. Reports whether it discarded corrupt data, for the caller to report once the lock is released.
async function readOutboxInTransaction() {
	const pendingTerminalReplies = await parseStoredOutbox()
	if (pendingTerminalReplies !== undefined) return { pendingTerminalReplies, discardedCorruptOutbox: false }
	await browser.storage.local.set(outboxStorageWrite([]))
	return { pendingTerminalReplies: [], discardedCorruptOutbox: true }
}

const reportDiscardedCorruptOutbox = async () => await reportLocalRecovery(new Error('Stored pending terminal replies failed runtime validation.'), {
	source: 'pending_terminal_replies',
	code: 'pending_terminal_replies_corrupt',
	message: 'Discarded corrupt pending terminal replies so wallet requests can continue.',
})

// Runs a plan of the pending-request storage transaction with the outbox as stored under its lock, and reports a discarded corrupt outbox after the lock is released.
async function runWithOutbox<Result>(plan: (pendingTerminalReplies: readonly QueuedTerminalReply[]) => Promise<{ readonly writes: readonly PendingRequestStorageWrite[], readonly result: Result }>) {
	const { result, discardedCorruptOutbox } = await runPendingRequestStorageTransaction(async () => {
		const outbox = await readOutboxInTransaction()
		const planned = await plan(outbox.pendingTerminalReplies)
		return { writes: planned.writes, result: { result: planned.result, discardedCorruptOutbox: outbox.discardedCorruptOutbox } }
	})
	if (discardedCorruptOutbox) await reportDiscardedCorruptOutbox()
	return result
}

// Reads the outbox outside any storage transaction. Only corrupt data takes the transaction lock, to read again and repair under it, so a reader that saw corrupt data never overwrites a reply a transaction queued meanwhile; it must not be called from inside a transaction plan, which would wait for that lock forever.
export async function getPendingTerminalReplies(): Promise<readonly QueuedTerminalReply[]> {
	const pendingTerminalReplies = await parseStoredOutbox()
	if (pendingTerminalReplies !== undefined) return pendingTerminalReplies
	return await runWithOutbox(async (pendingTerminalReplies) => ({ writes: [], result: pendingTerminalReplies }))
}

async function updatePendingTerminalReplies(update: (pendingReplies: readonly QueuedTerminalReply[]) => readonly QueuedTerminalReply[]) {
	return await runWithOutbox(async (current) => {
		const pendingTerminalReplies = update(current)
		return { writes: [outboxStorageWrite(pendingTerminalReplies)], result: pendingTerminalReplies }
	})
}

// Queues the reply for the pending request instance it answers in the same storage write as the decision on that instance, and neither when the decision leaves the instance 'unchanged'. The entry records the instance, so a later delivery, also after a restart, completes only that instance. A queued reply replaces any earlier one under the same request id.
export async function appendPendingTerminalReplyWithPendingRequestDecision(reply: InterceptedRequestForward, instance: PendingRequestInstance, decide: DecidePendingRequestInstance): Promise<PendingRequestInstanceOutcome> {
	return await runWithOutbox(async (queued) => {
		const decided = decidePendingRequestInstance(await readPendingRequestsInTransaction(), instance, decide)
		if (decided.outcome === 'unchanged') return { writes: [], result: decided.outcome }
		const pendingTerminalReplies = [...withoutReplyTo(queued, reply.uniqueRequestIdentifier), { reply, completes: { kind: 'pendingRequestInstance' as const, instanceId: instance.instanceId } }]
		return { writes: [pendingRequestsStorageWrite(decided.pendingTransactionsOrMessages), outboxStorageWrite(pendingTerminalReplies)], result: decided.outcome }
	})
}

// Removes a delivered reply from the outbox, together with the request instance still waiting for it (a popup-close rejection keeps its request ClosedWithoutResponse until delivered) in the same storage write, so a failure leaves both and a retry finds the reply delivered instead of posting it again. Does nothing when the outbox now holds a reply to another instance under that request id, which a newer request queued.
export async function removeDeliveredPendingTerminalReply(uniqueRequestIdentifier: UniqueRequestIdentifier, completes: TerminalReplyCompletion) {
	await runWithOutbox(async (queued) => {
		const delivered = queued.find((entry) => doesUniqueRequestIdentifiersMatch(entry.reply.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (delivered === undefined || !isSameTerminalReplyCompletion(delivered.completes, completes)) return { writes: [], result: undefined }
		const outboxWrite = outboxStorageWrite(withoutReplyTo(queued, uniqueRequestIdentifier))
		if (completes.kind === 'noPendingRequest') return { writes: [outboxWrite], result: undefined }
		const decided = decidePendingRequestInstance(await readPendingRequestsInTransaction(), { uniqueRequestIdentifier, instanceId: completes.instanceId }, (current) => current.approvalStatus.status === 'ClosedWithoutResponse' ? { type: 'remove' } : undefined)
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

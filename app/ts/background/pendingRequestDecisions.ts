import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import { updatePendingRequests } from './storageVariables.js'

// Decisions on pending requests, each made atomically in a pending-request storage transaction: storageVariables.ts owns the key, and this module only computes the new list from the one it read.

export type PendingRequestInstance = Pick<PendingTransactionOrSignableMessage, 'uniqueRequestIdentifier' | 'instanceId'>

export const isSamePendingRequestInstance = (first: PendingRequestInstance, second: PendingRequestInstance) => {
	return first.instanceId === second.instanceId && doesUniqueRequestIdentifiersMatch(first.uniqueRequestIdentifier, second.uniqueRequestIdentifier)
}

// Decides what happens to a pending request instance from how it is stored now; undefined leaves it alone. Synchronous, as it runs inside a pending-request storage transaction.
export type DecidePendingRequestInstance = (pendingTransactionOrMessage: PendingTransactionOrSignableMessage) => { type: 'store', pending: PendingTransactionOrSignableMessage } | { type: 'remove' } | undefined

export type PendingRequestInstanceOutcome = 'stored' | 'removed' | 'unchanged'

// Applies a decision to the pending request instance in a list, and reports the outcome of the decision it applied. The decision applies to the first request stored as that instance. Instance ids are random per request and a request id is refused while it is pending, so two requests share an instance only when both were stored under one request id before instance ids existed and parse as the legacy id; they are indistinguishable then, so the first one is decided on and the other stays as it was. Synchronous, as it runs inside a pending-request storage transaction.
export function decidePendingRequestInstance(pendingTransactionsOrMessages: readonly PendingTransactionOrSignableMessage[], instance: PendingRequestInstance, decide: DecidePendingRequestInstance) {
	const match = pendingTransactionsOrMessages.findIndex((pending) => isSamePendingRequestInstance(pending, instance))
	const found = pendingTransactionsOrMessages[match]
	const decision = found === undefined ? undefined : decide(found)
	if (decision === undefined) return { pendingTransactionsOrMessages, outcome: 'unchanged' as const }
	if (decision.type === 'remove') return { pendingTransactionsOrMessages: pendingTransactionsOrMessages.filter((_pending, index) => index !== match), outcome: 'removed' as const }
	return { pendingTransactionsOrMessages: replaceElementInReadonlyArray(pendingTransactionsOrMessages, match, decision.pending), outcome: 'stored' as const }
}

// Applies a decision to the pending request instance that was read earlier, so work that awaited in between never touches a different request the page sent under the same request id. Reports the outcome of the decision applied, once its write resolved: nothing is written when it is 'unchanged', because the instance is gone or the decision left it alone.
async function applyPendingRequestInstanceDecision(instance: PendingRequestInstance, decide: DecidePendingRequestInstance): Promise<PendingRequestInstanceOutcome> {
	let outcome: PendingRequestInstanceOutcome = 'unchanged'
	await updatePendingRequests((pendingTransactionsOrMessages) => {
		const decided = decidePendingRequestInstance(pendingTransactionsOrMessages, instance, decide)
		outcome = decided.outcome
		return decided.outcome === 'unchanged' ? undefined : decided.pendingTransactionsOrMessages
	})
	return outcome
}

// Updates only the pending request instance that was read earlier; update returns undefined to leave it as it is. Returns whether an update was stored.
export async function updatePendingTransactionOrMessageInstance(instance: PendingRequestInstance, update: (pendingTransactionOrMessage: PendingTransactionOrSignableMessage) => PendingTransactionOrSignableMessage | undefined) {
	const outcome = await applyPendingRequestInstanceDecision(instance, (current) => {
		const pending = update(current)
		return pending === undefined ? undefined : { type: 'store', pending }
	})
	return outcome === 'stored'
}

// Removes only the pending request instance that was read earlier, while isRemovable accepts it as stored now. Returns whether it was removed. A removal that answers the website goes through queueTerminalReplyWithPendingRequestDecision instead, which stores the reply in the same write.
export async function removePendingTransactionOrMessageInstance(instance: PendingRequestInstance, isRemovable: (pendingTransactionOrMessage: PendingTransactionOrSignableMessage) => boolean) {
	return await applyPendingRequestInstanceDecision(instance, (current) => isRemovable(current) ? { type: 'remove' } : undefined) === 'removed'
}

// The one write by request id, for signer replies, which name only the id. The wallet answers over the page's own connection, so the page owns that channel and could forge a reply for any of its ids; this is no defence against the page itself. It does make sure a reply only reaches the request under that id once it was forwarded to the signer, never a request the user has not approved, such as a newer request under a reused id. Work that read a pending request and writes back uses updatePendingTransactionOrMessageInstance.
export async function setApprovalStatusOfRequestWaitingForSignerById(uniqueRequestIdentifier: UniqueRequestIdentifier, approvalStatus: PendingTransactionOrSignableMessage['approvalStatus']) {
	await updatePendingRequests((pendingTransactionsOrMessages) => pendingTransactionsOrMessages.map((pending) => {
		if (!doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier) || pending.approvalStatus.status !== 'WaitingForSigner') return pending
		return modifyObject(pending, { approvalStatus })
	}))
}

// Returns false without appending when a request with the same id is already pending. Pages choose request ids and the bridge does not deduplicate negative ones, so refusing duplicates here, atomically with the append, keeps every lookup of a pending request by id unambiguous.
export async function appendPendingTransactionOrMessage(pendingTransactionOrMessage: PendingTransactionOrSignableMessage) {
	const written = await updatePendingRequests((pendingTransactionsOrMessages) => {
		if (pendingTransactionsOrMessages.some((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, pendingTransactionOrMessage.uniqueRequestIdentifier))) return undefined
		return [...pendingTransactionsOrMessages, pendingTransactionOrMessage]
	})
	return written !== undefined
}

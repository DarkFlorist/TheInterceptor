import { createStorageTransactionRunner } from './storageTransaction.js'

// The serialized items of the two keys this transaction covers, each built by its owner: storageVariables.ts for the pending requests and pendingTerminalReplies.ts for the reply outbox.
export type PendingRequestStorageWrite = {
	readonly pendingTransactionsAndMessages?: unknown
	readonly pendingTerminalReplies?: unknown
}

// The one lock of every read-modify-write of the pending requests and the reply outbox. A terminal reply is queued in the same storage set as the decision on the request it answers, so a crash or a failed write stores both or neither; Chromium applies one storage.local.set as one leveldb write batch and Firefox as one IndexedDB transaction. Both keys share this lock, so an outbox written with the pending requests is always derived from a read under it, and there is no acquisition order between two locks to get wrong. Plans must not await other locks; terminalReplyDelivery.ts takes its delivery lock before this one, never inside it.
export const runPendingRequestStorageTransaction = createStorageTransactionRunner<PendingRequestStorageWrite>(async (writes) => {
	await browser.storage.local.set(writes.reduce<PendingRequestStorageWrite>((items, write) => ({ ...items, ...write }), {}))
})

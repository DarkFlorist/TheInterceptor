import type { PendingTransactionBatch, PendingTransactionOrSignableMessage, WalletSendCallsBatchIdRecord, WalletSendCallsBinding } from '../types/accessRequest.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndWalletSendCallsBatchIds, getWalletSendCallsBatchIds, updatePendingTransactionsAndWalletSendCallsBatchIds } from './storageVariables.js'

// The ids of wallet_sendCalls batches and of their calls, and the registry of the batch ids that websites use, which storageVariables.ts writes atomically together with the confirmation queue. This module owns the registry and the one rule for whether an approved bundle still exists (isWalletSendCallsBundleOnStack). The simulation stack is that rule's source of truth by design: in simulation mode an approved bundle is nothing but its calls on the stack, so editing the stack (removing a call, importing or resetting the stack) is what ends a bundle, and no stack writer has to update the registry. Records of ended bundles stay stored until the next admission prunes them, and are ignored until then because every reader applies the same rule.

const getWalletSendCallsIdentifierHash = (uniqueRequestIdentifier: UniqueRequestIdentifier, suffix: string) => keccak256(stringToBytes(`${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) }|wallet_sendCalls|${ suffix }`))

export const getWalletSendCallsBatchId = (uniqueRequestIdentifier: UniqueRequestIdentifier) => getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, 'batch')

export const getWalletSendCallTransactionIdentifier = (uniqueRequestIdentifier: UniqueRequestIdentifier, callIndex: number) => BigInt(getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, `call:${ callIndex }`))

// Batch ids must be unique per website, because wallet_getCallsStatus looks them up by id and origin. One store of records answers both whether an id is in use and which calls wallet_getCallsStatus reports for it. A record is added in the storage write that adds its batch to the confirmation queue, and removed in the write that removes a batch that was not approved. Approval adds the batch's calls to the simulation stack, and that stack write alone commits it: a batch whose bundle is on the stack is approved even if a restart interrupted the approval before it answered the website, so nothing has to be written atomically with the stack. A record is therefore in use while its batch is in the queue or its bundle is on the stack (see isWalletSendCallsBundleOnStack), and each admission drops the records that are neither, so the store holds no more batches than the queue and the stack.
const getBatchIdKey = (websiteOrigin: string, batchId: string) => `${ websiteOrigin }\n${ batchId }`
const isRecordOfBatchId = (websiteOrigin: string, batchId: string) => (record: WalletSendCallsBatchIdRecord) => record.binding.websiteOrigin === websiteOrigin && record.batchId === batchId

// A set, so checking every record against the stack takes one pass over the stack instead of one per record.
const getStackTransactionIdentifiers = (stack: InterceptorTransactionStack): ReadonlySet<bigint> => new Set(stack.operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.transactionIdentifier] : []))

// The one definition of whether a wallet_sendCalls bundle exists: every call recorded for it is a transaction on the simulation stack. The id registry, wallet_getCallsStatus and the resolution of an interrupted approval all decide by it, so a stack change that removes any call of a bundle ends the bundle everywhere at once: it is unknown to wallet_getCallsStatus (5730) and its id can be submitted again.
export const isWalletSendCallsBundleOnStack = (bundleTransactionIdentifiers: readonly bigint[], stackTransactionIdentifiers: ReadonlySet<bigint>) => bundleTransactionIdentifiers.every((transactionIdentifier) => stackTransactionIdentifiers.has(transactionIdentifier))

const getWalletSendCallTransactionIdentifiers = (pendingBatch: PendingTransactionBatch) => pendingBatch.originalRequestParameters.params[0].calls.map((_call, callIndex) => getWalletSendCallTransactionIdentifier(pendingBatch.uniqueRequestIdentifier, callIndex))

// Where a queued batch's calls are on the simulation stack. Approval adds all of them in one stack write and nothing adds them again, so calls on the stack mean the approval was committed: 'bundleOnStack' while every call is there, and 'callsPartlyRemoved' once the user removed some of them. 'notOnStack' covers a batch that was never approved and one whose calls were all removed.
export type TransactionBatchStackState = 'bundleOnStack' | 'callsPartlyRemoved' | 'notOnStack'

export function getTransactionBatchStackState(pendingBatch: PendingTransactionBatch, stack: InterceptorTransactionStack): TransactionBatchStackState {
	const batchTransactionIdentifiers = getWalletSendCallTransactionIdentifiers(pendingBatch)
	const stackTransactionIdentifiers = getStackTransactionIdentifiers(stack)
	if (isWalletSendCallsBundleOnStack(batchTransactionIdentifiers, stackTransactionIdentifiers)) return 'bundleOnStack'
	return batchTransactionIdentifiers.some((transactionIdentifier) => stackTransactionIdentifiers.has(transactionIdentifier)) ? 'callsPartlyRemoved' : 'notOnStack'
}

// Whether a record is in use, checked against one read of the queue and the stack. The queued batches and the stack's transactions are indexed once, so checking every record is one pass over each.
const createBatchIdRecordInUseCheck = (pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], stack: InterceptorTransactionStack) => {
	const queuedBatchKeys = new Set(pendingTransactionsAndMessages.flatMap((pending) => pending.type === 'TransactionBatch' ? [getBatchIdKey(pending.binding.websiteOrigin, pending.batchId)] : []))
	const stackTransactionIdentifiers = getStackTransactionIdentifiers(stack)
	return (record: WalletSendCallsBatchIdRecord) => queuedBatchKeys.has(getBatchIdKey(record.binding.websiteOrigin, record.batchId)) || isWalletSendCallsBundleOnStack(record.transactionIdentifiers, stackTransactionIdentifiers)
}

// Only admissions add records, and they run one at a time while holding the confirmation lock, so an id found free here stays free until the caller adds its batch.
export async function isWalletSendCallsIdInUse(websiteOrigin: string, batchId: string) {
	const { pendingTransactionsAndMessages, walletSendCallsBatchIds } = await getPendingTransactionsAndWalletSendCallsBatchIds()
	// Read after the queue: an approval adds a batch's calls to the stack before it removes the batch from the queue, so a batch that left the queue since the first read is on the stack.
	const isInUse = createBatchIdRecordInUseCheck(pendingTransactionsAndMessages, await getInterceptorTransactionStack())
	return walletSendCallsBatchIds.some((record) => isRecordOfBatchId(websiteOrigin, batchId)(record) && isInUse(record))
}

export async function addPendingTransactionBatch(pendingBatch: PendingTransactionBatch) {
	const record = { binding: pendingBatch.binding, batchId: pendingBatch.batchId, transactionIdentifiers: getWalletSendCallTransactionIdentifiers(pendingBatch) }
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => {
		// The stack is read after the queue, inside the queue's write: an approval adds its calls to the stack before it removes its batch from the queue, so a record whose batch left the queue since the queue read is found on the stack. Reading the stack first could prune a record whose bundle was just approved.
		const isInUse = createBatchIdRecordInUseCheck(pendingTransactionsAndMessages, await getInterceptorTransactionStack())
		return {
			pendingTransactionsAndMessages: [...pendingTransactionsAndMessages, pendingBatch],
			walletSendCallsBatchIds: [...walletSendCallsBatchIds.filter(isInUse), record],
		}
	})
}

const withoutPendingBatch = (pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], pendingBatch: PendingTransactionBatch) => pendingTransactionsAndMessages.filter((pending) => !doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, pendingBatch.uniqueRequestIdentifier))

// Removes a batch that was not approved from the confirmation queue and releases its id.
export async function releasePendingTransactionBatch(pendingBatch: PendingTransactionBatch) {
	const isRecordOfThisBatch = isRecordOfBatchId(pendingBatch.binding.websiteOrigin, pendingBatch.batchId)
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => ({
		pendingTransactionsAndMessages: withoutPendingBatch(pendingTransactionsAndMessages, pendingBatch),
		walletSendCallsBatchIds: walletSendCallsBatchIds.filter((record) => !isRecordOfThisBatch(record)),
	}))
}

// Removes an approved batch, whose bundle is on the simulation stack, from the confirmation queue. Its id stays in use while its bundle is on the stack.
export async function removeApprovedTransactionBatch(pendingBatch: PendingTransactionBatch) {
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => ({
		pendingTransactionsAndMessages: withoutPendingBatch(pendingTransactionsAndMessages, pendingBatch),
		walletSendCallsBatchIds,
	}))
}

// The calls of the bundle a website submitted under a batch id, when the batch was submitted from the requester's current account on its current network and the bundle still exists on the simulation stack (isWalletSendCallsBundleOnStack). Otherwise undefined, which wallet_getCallsStatus answers as unknown (5730): after a network or account switch it must not report receipts simulated in the new context under the original chainId. It reads only storage, so wallet_getCallsStatus decides whether a bundle is known before it prepares or runs any simulation. Ids stay unique per website regardless of context (see isWalletSendCallsIdInUse).
export async function getWalletSendCallsBundleForRequester(requester: WalletSendCallsBinding, batchId: string) {
	const record = (await getWalletSendCallsBatchIds()).find(isRecordOfBatchId(requester.websiteOrigin, batchId))
	if (record === undefined || record.binding.account !== requester.account || record.binding.chainId !== requester.chainId) return undefined
	if (!isWalletSendCallsBundleOnStack(record.transactionIdentifiers, getStackTransactionIdentifiers(await getInterceptorTransactionStack()))) return undefined
	return record.transactionIdentifiers
}

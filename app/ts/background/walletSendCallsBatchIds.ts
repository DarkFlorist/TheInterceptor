import type { PendingTransactionBatch, PendingTransactionOrSignableMessage, WalletSendCallsBatchIdRecord } from '../types/accessRequest.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndWalletSendCallsBatchIds, getWalletSendCallsBatchIds, updatePendingTransactionsAndWalletSendCallsBatchIds } from './storageVariables.js'

// The ids of wallet_sendCalls batches and of their calls, and the registry of the batch ids that websites use, which storageVariables.ts writes atomically together with the confirmation queue.

const getWalletSendCallsIdentifierHash = (uniqueRequestIdentifier: UniqueRequestIdentifier, suffix: string) => keccak256(stringToBytes(`${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) }|wallet_sendCalls|${ suffix }`))

export const getWalletSendCallsBatchId = (uniqueRequestIdentifier: UniqueRequestIdentifier) => getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, 'batch')

export const getWalletSendCallTransactionIdentifier = (uniqueRequestIdentifier: UniqueRequestIdentifier, callIndex: number) => BigInt(getWalletSendCallsIdentifierHash(uniqueRequestIdentifier, `call:${ callIndex }`))

// Batch ids must be unique per website, because wallet_getCallsStatus looks them up by id and origin. One store of records answers both whether an id is in use and which calls wallet_getCallsStatus reports for it. A record is added in the storage write that adds its batch to the confirmation queue, and removed in the write that removes a batch that was not approved. Approval adds the batch's calls to the simulation stack, and that stack write alone commits it: a batch whose bundle is on the stack is approved even if a restart interrupted the approval before it answered the website, so nothing has to be written atomically with the stack. A record is therefore in use while its batch is in the queue or its bundle is on the stack (see isWalletSendCallsBundleOnStack), and each admission drops the records that are neither, so the store holds no more batches than the queue and the stack.
const isRecordOfBatchId = (websiteOrigin: string, batchId: string) => (record: WalletSendCallsBatchIdRecord) => record.websiteOrigin === websiteOrigin && record.batchId === batchId

const getStackTransactionIdentifiers = (stack: InterceptorTransactionStack) => stack.operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.transactionIdentifier] : [])

// The one definition of whether a wallet_sendCalls bundle exists: every call recorded for it is a transaction on the simulation stack. The id registry, wallet_getCallsStatus and the resolution of an interrupted approval all decide by it, so a stack change that removes any call of a bundle ends the bundle everywhere at once: it is unknown to wallet_getCallsStatus (5730) and its id can be submitted again.
export const isWalletSendCallsBundleOnStack = (bundleTransactionIdentifiers: readonly bigint[], stackTransactionIdentifiers: readonly bigint[]) => bundleTransactionIdentifiers.every((transactionIdentifier) => stackTransactionIdentifiers.includes(transactionIdentifier))

const getWalletSendCallTransactionIdentifiers = (pendingBatch: PendingTransactionBatch) => pendingBatch.originalRequestParameters.params[0].calls.map((_call, callIndex) => getWalletSendCallTransactionIdentifier(pendingBatch.uniqueRequestIdentifier, callIndex))

// Where a queued batch's calls are on the simulation stack. Approval adds all of them in one stack write and nothing adds them again, so calls on the stack mean the approval was committed: 'bundleOnStack' while every call is there, and 'callsPartlyRemoved' once the user removed some of them. 'notOnStack' covers a batch that was never approved and one whose calls were all removed.
export type TransactionBatchStackState = 'bundleOnStack' | 'callsPartlyRemoved' | 'notOnStack'

export function getTransactionBatchStackState(pendingBatch: PendingTransactionBatch, stack: InterceptorTransactionStack): TransactionBatchStackState {
	const batchTransactionIdentifiers = getWalletSendCallTransactionIdentifiers(pendingBatch)
	const stackTransactionIdentifiers = getStackTransactionIdentifiers(stack)
	if (isWalletSendCallsBundleOnStack(batchTransactionIdentifiers, stackTransactionIdentifiers)) return 'bundleOnStack'
	return batchTransactionIdentifiers.some((transactionIdentifier) => stackTransactionIdentifiers.includes(transactionIdentifier)) ? 'callsPartlyRemoved' : 'notOnStack'
}

const isWalletSendCallsBatchIdRecordInUse = (record: WalletSendCallsBatchIdRecord, pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], stack: InterceptorTransactionStack) =>
	pendingTransactionsAndMessages.some((pending) => pending.type === 'TransactionBatch' && isRecordOfBatchId(pending.binding.websiteOrigin, pending.batchId)(record))
	|| isWalletSendCallsBundleOnStack(record.transactionIdentifiers, getStackTransactionIdentifiers(stack))

// Only admissions add records, and they run one at a time while holding the confirmation lock, so an id found free here stays free until the caller adds its batch.
export async function isWalletSendCallsIdInUse(websiteOrigin: string, batchId: string) {
	const { pendingTransactionsAndMessages, walletSendCallsBatchIds } = await getPendingTransactionsAndWalletSendCallsBatchIds()
	// Read after the queue: an approval adds a batch's calls to the stack before it removes the batch from the queue, so a batch that left the queue since the first read is on the stack.
	const stack = await getInterceptorTransactionStack()
	return walletSendCallsBatchIds.some((record) => isRecordOfBatchId(websiteOrigin, batchId)(record) && isWalletSendCallsBatchIdRecordInUse(record, pendingTransactionsAndMessages, stack))
}

export async function addPendingTransactionBatch(pendingBatch: PendingTransactionBatch) {
	const record = { websiteOrigin: pendingBatch.binding.websiteOrigin, batchId: pendingBatch.batchId, transactionIdentifiers: getWalletSendCallTransactionIdentifiers(pendingBatch) }
	await updatePendingTransactionsAndWalletSendCallsBatchIds(async ({ pendingTransactionsAndMessages, walletSendCallsBatchIds }) => {
		const stack = await getInterceptorTransactionStack()
		return {
			pendingTransactionsAndMessages: [...pendingTransactionsAndMessages, pendingBatch],
			walletSendCallsBatchIds: [...walletSendCallsBatchIds.filter((existingRecord) => isWalletSendCallsBatchIdRecordInUse(existingRecord, pendingTransactionsAndMessages, stack)), record],
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

// The calls recorded for a website's batch id, while its record is kept. wallet_getCallsStatus reports them only while isWalletSendCallsBundleOnStack holds.
export async function getWalletSendCallsBatchTransactionIdentifiers(websiteOrigin: string, batchId: string) {
	return (await getWalletSendCallsBatchIds()).find(isRecordOfBatchId(websiteOrigin, batchId))?.transactionIdentifiers
}

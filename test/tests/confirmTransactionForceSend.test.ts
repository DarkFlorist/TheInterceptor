import * as assert from 'node:assert'
import { beforeEach, test } from 'bun:test'
import { createRecordingPort, getPopupReviewedResultId, isRecord, modules, pendingTransaction, resetConfirmTransactionTestState, simulator, uniqueRequestIdentifier, withSimulatedTransactionResult } from './confirmTransactionTestHarness.js'
import type { BackgroundPendingTransactionOrSignableMessage, PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { TransactionConfirmation } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
const { shouldDisableConfirm, getConfirmationReviewRefusal } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

beforeEach(resetConfirmTransactionTestState)

// A request whose simulation located a succeeding result, so only the gas edit stands between it and an ordinary accept.
const simulatedPending = withSimulatedTransactionResult(pendingTransaction)
const editedPending = {
	...simulatedPending,
	originalRequestParameters: {
		...simulatedPending.originalRequestParameters,
		params: [{ ...simulatedPending.originalRequestParameters.params[0], gas: 30_000n }],
	},
}

// The accept the popup sends for the request it reviewed, with or without the send-anyway override.
function approval(reviewed: PendingTransactionOrSignableMessage, forceSend: boolean): TransactionConfirmation {
	// Exercise the real popup transport, including its bigint conversion and runtime schema.
	return TransactionConfirmation.parse(JSON.parse(JSON.stringify(serialize(TransactionConfirmation, {
		method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier, reviewedResultId: getPopupReviewedResultId(reviewed), forceSend },
	}))))
}

// The request as the background stores it, which is what the popup reviewed; storage round-trips can change fields the reviewed-result id covers.
async function getStoredRequest() {
	const [stored] = await modules.getPendingTransactionsAndMessages()
	assert.ok(stored)
	return stored
}

function recordingConnections(postedMessages: unknown[]) {
	const socket = uniqueRequestIdentifier.requestSocket
	return new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: {
			port: createRecordingPort(postedMessages), socket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true,
		},
	} }]])
}

test('explicit force-send enables a gas edit while ordinary approval and creation/signer blockers remain disabled', () => {
	const shown = { ...editedPending, source: 'background' as const, reviewedResultId: getPopupReviewedResultId(editedPending) }
	assert.equal(shouldDisableConfirm(shown, false), true)
	assert.equal(shouldDisableConfirm(shown, true), false)
	assert.equal(shouldDisableConfirm({ ...shown, approvalStatus: { status: 'WaitingForSigner' } }, true), true)
	assert.equal(shouldDisableConfirm({ ...shown, transactionOrMessageCreationStatus: 'Simulating' }, true), true)
})

test.each([
	['the edited gas', false],
	['the gas before the edit', false],
	['the gas before the edit', true],
] as const)('backend rejects stale approval reviewing %s (force-send %p)', async (reviewedGas, forceSend) => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [simulatedPending] })
	const beforeEdit = await getStoredRequest()
	await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 30_000n)
	const edited = await getStoredRequest()
	const postedMessages: unknown[] = []
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(reviewedGas === 'the edited gas' ? edited : beforeEdit, forceSend)), false)
	assert.equal(postedMessages.length, 0)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 0)
})

test('force-send forwards the approved edited gas to the wallet without waiting for simulation', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const signingPending = { ...editedPending, simulationMode: false }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [signingPending] })
	const postedMessages: unknown[] = []
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(await getStoredRequest(), true)), true)
	const forwarded = postedMessages.find(message => isRecord(message) && message.type === 'forwardToSigner')
	assert.ok(forwarded)
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	assert.equal(SendTransactionParams.parse(forwarded).params[0].gas, 30_000n)
	const [waiting] = await modules.getPendingTransactionsAndMessages()
	assert.equal(waiting?.approvalStatus.status, 'WaitingForSigner')
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(await getStoredRequest(), true)), false)
	assert.equal(postedMessages.length, 1, 'Force-send must not send a second request while the wallet is pending')
})

test('force-send signs and appends edited gas instead of reusing a stale simulated transaction or signature', async () => {
	const presignedPending = {
		...editedPending,
		transactionToSimulate: { ...editedPending.transactionToSimulate, signedTransaction: modules.mockSignTransaction(editedPending.transactionToSimulate.transaction) },
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [presignedPending] })
	const postedMessages: unknown[] = []
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(await getStoredRequest(), true))
	const [operation] = (await modules.getInterceptorTransactionStack()).operations
	assert.ok(operation?.type === 'Transaction')
	assert.equal(operation.preSimulationTransaction.signedTransaction.gas, 30_000n)
	assert.equal(operation.preSimulationTransaction.signedTransaction.hash, modules.mockSignTransaction({ ...editedPending.transactionToSimulate.transaction, gas: 30_000n }).hash)
	assert.equal(operation.preSimulationTransaction.originalRequestParameters.method, 'eth_sendTransaction')
	if (operation.preSimulationTransaction.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Expected an editable transaction')
	assert.equal(operation.preSimulationTransaction.originalRequestParameters.params[0].gas, 30_000n)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
})

test('force-send cannot approve initial simulation or revive a rejected request', async () => {
	const postedMessages: unknown[] = []
	const connections = recordingConnections(postedMessages)
	const simulatingPending = { ...editedPending, transactionOrMessageCreationStatus: 'Simulating' as const }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [simulatingPending] })
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(await getStoredRequest(), true)), false)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [editedPending] })
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, {
		method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
	})
	const replyCountAfterRejection = postedMessages.length
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(editedPending, true))
	assert.equal(postedMessages.length, replyCountAfterRejection)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 0)
})

test('two concurrent accepts forward the request to the wallet only once', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const signingPending = { ...editedPending, simulationMode: false }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [signingPending] })
	const reviewed = await getStoredRequest()
	const postedMessages: unknown[] = []
	const connections = recordingConnections(postedMessages)
	const results = await Promise.all([
		modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(reviewed, true)),
		modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(reviewed, true)),
	])
	assert.deepEqual([...results].sort(), [false, true])
	assert.equal(postedMessages.filter(message => isRecord(message) && message.type === 'forwardToSigner').length, 1)
})


test('a completed stale confirmation is explained only for the same waiting background request', () => {
	const before: BackgroundPendingTransactionOrSignableMessage = { ...simulatedPending, source: 'background', reviewedResultId: 'before' }
	const attempt = { ...before, forceSend: false }
	const after = { ...before, reviewedResultId: 'after' }
	assert.equal(getConfirmationReviewRefusal(after, attempt), 'reviewChanged')
	assert.equal(getConfirmationReviewRefusal(before, attempt), undefined)
	assert.equal(getConfirmationReviewRefusal(undefined, attempt), undefined)
	assert.equal(getConfirmationReviewRefusal(after, undefined), undefined)
	assert.equal(getConfirmationReviewRefusal({ ...after, source: 'storage' }, attempt), undefined)
	assert.equal(getConfirmationReviewRefusal({ ...after, instanceId: 'replacement' }, attempt), undefined)
	assert.equal(getConfirmationReviewRefusal({ ...after, uniqueRequestIdentifier: { ...after.uniqueRequestIdentifier, requestId: after.uniqueRequestIdentifier.requestId + 1 } }, attempt), undefined)
	assert.equal(getConfirmationReviewRefusal({ ...after, approvalStatus: { status: 'WaitingForSigner' } }, attempt), undefined)
})

test('confirmation explanations use shared acceptance rules for unsimulated gas, unavailable results and send-anyway consent', () => {
	const before: BackgroundPendingTransactionOrSignableMessage = { ...simulatedPending, source: 'background', reviewedResultId: 'review' }
	const attempt = { ...before, forceSend: false }
	assert.equal(getConfirmationReviewRefusal({ ...before, transactionOrMessageCreationStatus: 'Simulating' }, attempt), 'notSimulated')
	const gasEdited: BackgroundPendingTransactionOrSignableMessage = { ...editedPending, source: 'background', reviewedResultId: 'review' }
	assert.equal(getConfirmationReviewRefusal(gasEdited, attempt), 'gasLimitChanged')
	assert.equal(getConfirmationReviewRefusal(gasEdited, { ...attempt, forceSend: true }), undefined)
	const rejectOnly: BackgroundPendingTransactionOrSignableMessage = { ...before, popupVisualisation: { statusCode: 'failed', data: { ...before.popupVisualisation.data, error: { code: -32000, message: 'No reviewable result', decodedErrorMessage: 'No reviewable result' } } } }
	assert.equal(getConfirmationReviewRefusal(rejectOnly, { ...attempt, forceSend: true }), 'rejectOnly')
	const quarantined = withSimulatedTransactionResult(pendingTransaction, { transactionStatus: 'Transaction Succeeded' }, true)
	const shown: BackgroundPendingTransactionOrSignableMessage = { ...quarantined, source: 'background', reviewedResultId: 'review' }
	assert.equal(getConfirmationReviewRefusal(shown, attempt), 'sendAnywayRequired')
	assert.equal(getConfirmationReviewRefusal(shown, { ...attempt, forceSend: true }), undefined)
})

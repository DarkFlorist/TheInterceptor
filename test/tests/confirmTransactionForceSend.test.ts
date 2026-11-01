import * as assert from 'node:assert'
import { beforeEach, test } from 'bun:test'
import { createRecordingPort, isRecord, modules, pendingTransaction, resetConfirmTransactionTestState, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { TransactionConfirmation } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
const { shouldDisableTransactionConfirm } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

beforeEach(resetConfirmTransactionTestState)

const editedPending = {
	...pendingTransaction,
	originalRequestParameters: {
		...pendingTransaction.originalRequestParameters,
		params: [{ ...pendingTransaction.originalRequestParameters.params[0], gas: 30_000n }],
	},
}

function approval(forceSendGasLimit?: bigint): TransactionConfirmation {
	// Exercise the real popup transport, including its bigint conversion and runtime schema.
	return TransactionConfirmation.parse(JSON.parse(JSON.stringify(serialize(TransactionConfirmation, {
		method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier, forceSendGasLimit },
	}))))
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
	assert.equal(shouldDisableTransactionConfirm(editedPending, false), true)
	assert.equal(shouldDisableTransactionConfirm(editedPending, true), false)
	assert.equal(shouldDisableTransactionConfirm({ ...editedPending, approvalStatus: { status: 'WaitingForSigner' } }, true), true)
	assert.equal(shouldDisableTransactionConfirm({ ...editedPending, transactionOrMessageCreationStatus: 'Simulating' }, true), true)
})

test.each([undefined, 21_000n, 40_000n])('backend rejects stale approval with force-send gas %s', async forceSendGasLimit => {
	await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 30_000n)
	const postedMessages: unknown[] = []
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(forceSendGasLimit)), false)
	assert.equal(postedMessages.length, 0)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 0)
})

test('force-send forwards the approved edited gas to the wallet without waiting for simulation', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...editedPending, simulationMode: false }] })
	const postedMessages: unknown[] = []
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(30_000n)), true)
	const forwarded = postedMessages.find(message => isRecord(message) && message.type === 'forwardToSigner')
	assert.ok(forwarded)
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	assert.equal(SendTransactionParams.parse(forwarded).params[0].gas, 30_000n)
	const [waiting] = await modules.getPendingTransactionsAndMessages()
	assert.equal(waiting?.approvalStatus.status, 'WaitingForSigner')
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(30_000n)), false)
	assert.equal(postedMessages.length, 1, 'Force-send must not send a second request while the wallet is pending')
})

test('force-send signs and appends edited gas instead of reusing a stale simulated transaction or signature', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{
		...editedPending,
		transactionToSimulate: { ...editedPending.transactionToSimulate, signedTransaction: modules.mockSignTransaction(editedPending.transactionToSimulate.transaction) },
	}] })
	const postedMessages: unknown[] = []
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, recordingConnections(postedMessages), approval(30_000n))
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
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...editedPending, transactionOrMessageCreationStatus: 'Simulating' }] })
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(30_000n)), false)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [editedPending] })
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, {
		method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier },
	})
	const replyCountAfterRejection = postedMessages.length
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections, approval(30_000n))
	assert.equal(postedMessages.length, replyCountAfterRejection)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 0)
})

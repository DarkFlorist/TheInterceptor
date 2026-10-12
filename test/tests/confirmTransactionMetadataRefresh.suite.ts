import * as assert from 'assert'
import { test } from 'bun:test'
import { publishFailedPopupVisualisation, refreshPopupVisualisationMetadataForOpenConsumer, updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import { getPopupVisualisationState, removePendingTransactionOrMessage, updatePopupVisualisationWithCallBack } from '../../app/ts/background/storageVariables.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { CompleteVisualizedSimulation, type SimulatedAndVisualizedTransaction, type VisualizedSimulationState, type WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { last } from '../../app/ts/utils/array.js'
import { activeAddress, browserMock, created, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, modules, oldTimestamp, recipientAddress, simulator, uniqueRequestIdentifier, type StorageKeys } from './confirmTransactionTestHarness.js'

// Loaded after the harness installs the extension globals that the popup handler dependencies require at import time.
const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')

function getDefined<Value>(value: Value | undefined, description: string): Value {
	if (value === undefined) throw new Error(`Missing ${ description }`)
	return value
}

const NOT_IN_ADDRESS_BOOK_WARNING = 'which is not in the addressbook'
const sentEther = 1n
const sender = getDefined(activeAddress, 'default active address')
const recipient = getDefined(recipientAddress, 'default recipient address')
const senderAddressBookEntry = getDefined(modules.defaultActiveAddresses[0], 'default active address entry')
const recipientContact: AddressBookEntry = {
	type: 'contact',
	name: 'Renamed recipient',
	address: recipient,
	entrySource: 'User',
	chainId: fakeRpcNetwork.chainId,
}
const website: Website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }

const sendEtherRequestParameters: SendTransactionParams = {
	method: 'eth_sendTransaction',
	params: [{
		from: sender,
		to: recipient,
		value: sentEther,
		gas: 21_000n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		input: new Uint8Array(),
	}],
}

const sendEtherTransaction: EthereumUnsignedTransaction = {
	type: '1559',
	from: sender,
	chainId: fakeRpcNetwork.chainId,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21_000n,
	to: recipient,
	value: sentEther,
	input: new Uint8Array(),
	accessList: [],
}

const sendEtherWebsiteTransaction: WebsiteCreatedEthereumTransaction = {
	website,
	created,
	originalRequestParameters: sendEtherRequestParameters,
	transactionIdentifier: 1n,
	success: true,
	transaction: sendEtherTransaction,
}

// The placeholder visualisation is older than any simulation, so the first confirmation simulation replaces it.
const sendEtherPendingTransaction: PendingTransactionOrSignableMessage = {
	type: 'Transaction',
	popupOrTabId: { type: 'popup', id: 1 },
	originalRequestParameters: sendEtherRequestParameters,
	uniqueRequestIdentifier,
	simulationMode: true,
	activeAddress: sender,
	created,
	transactionIdentifier: sendEtherWebsiteTransaction.transactionIdentifier,
	website,
	approvalStatus: { status: 'WaitingForUser' },
	transactionOrMessageCreationStatus: 'Simulated',
	transactionToSimulate: sendEtherWebsiteTransaction,
	popupVisualisation: {
		statusCode: 'failed',
		data: {
			activeAddress: sender,
			simulationMode: true,
			simulationStartedTimestamp: oldTimestamp,
			uniqueRequestIdentifier,
			transactionToSimulate: sendEtherWebsiteTransaction,
			signerName: 'NoSignerDetected',
			error: { code: -1, message: 'Not simulated yet', decodedErrorMessage: 'Not simulated yet' },
			simulationState: { blockNumber: 0n, simulationConductedTimestamp: oldTimestamp },
		},
	},
}

async function storeStackSendingEtherToRecipient() {
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				signedTransaction: modules.mockSignTransaction(sendEtherTransaction),
				website,
				created,
				originalRequestParameters: sendEtherRequestParameters,
				transactionIdentifier: 2n,
			},
		}],
	}))
}

// Simulates the stack and a pending confirmation that both send ether to a recipient that is not yet in the address book.
async function openSimulationModeConfirmationSendingEtherToUnknownRecipient() {
	await modules.browserStorageLocalSet({
		simulationMode: true,
		activeRpcNetwork: fakeRpcNetwork,
		makeCurrentAddressRich: false,
		userAddressBookEntriesV3: [senderAddressBookEntry],
	})
	await storeStackSendingEtherToRecipient()
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [sendEtherPendingTransaction] })
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
}

function getSimulatedPendingTransaction(pending: PendingTransactionOrSignableMessage | undefined) {
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a simulated pending transaction')
	return pending.popupVisualisation.data
}

function getLastVisualizedTransaction(visualizedSimulationState: VisualizedSimulationState): SimulatedAndVisualizedTransaction {
	if (visualizedSimulationState.success === false) throw new Error('Expected a successful simulation')
	const transaction = last(visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions))
	if (transaction === undefined) throw new Error('Expected a simulated and visualized transaction')
	return transaction
}

async function getStoredPendingTransactionVisualisation() {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	return getSimulatedPendingTransaction(pending)
}

async function getStoredStackVisualisation() {
	const stored = await getPopupVisualisationState()
	if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated stack visualisation')
	return { stored, simulationState: stored.simulationState.value }
}

const hasNotInAddressBookWarning = (transaction: SimulatedAndVisualizedTransaction) => transaction.quarantineReasons.some((reason) => reason.includes(NOT_IN_ADDRESS_BOOK_WARNING))

test('address-book edits re-label an open simulation-mode confirmation and its stack without simulating again', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	const pendingBefore = await getStoredPendingTransactionVisualisation()
	const stackBefore = await getStoredStackVisualisation()
	assert.notEqual(getLastVisualizedTransaction(pendingBefore.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	assert.notEqual(getLastVisualizedTransaction(stackBefore.stored.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	fakeSafeContract.requestedRpcMethods.length = 0
	browserMock.sentMessages.length = 0

	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	const pendingAfter = await getStoredPendingTransactionVisualisation()
	assert.equal(getLastVisualizedTransaction(pendingAfter.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	assert.equal(pendingAfter.simulationState.simulationConductedTimestamp.getTime(), pendingBefore.simulationState.simulationConductedTimestamp.getTime())
	const stackAfter = await getStoredStackVisualisation()
	assert.equal(getLastVisualizedTransaction(stackAfter.stored.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	assert.equal(stackAfter.stored.simulationId, stackBefore.stored.simulationId)
	assert.equal(stackAfter.simulationState.simulationConductedTimestamp.getTime(), stackBefore.simulationState.simulationConductedTimestamp.getTime())
	// Only the confirmation dialog is updated. No popup_simulation_state_changed is published, which FetchSimulationStack would answer by requesting new simulations.
	assert.deepEqual(browserMock.sentMessages.map((message) => message.method).sort(), ['popup_update_confirm_transaction_dialog', 'popup_update_confirm_transaction_dialog_pending_transactions'])
})

test('address-book edits re-label the stack for the home popup and stack page without simulating or broadcasting', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	const stackBefore = await getStoredStackVisualisation()
	fakeSafeContract.requestedRpcMethods.length = 0
	browserMock.sentMessages.length = 0

	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	const returnedVisualisation = await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	assert.equal(getLastVisualizedTransaction(returnedVisualisation.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	const stackAfter = await getStoredStackVisualisation()
	assert.equal(getLastVisualizedTransaction(stackAfter.stored.visualizedSimulationState).transaction.to?.name, recipientContact.name)
	assert.equal(stackAfter.stored.simulationId, stackBefore.stored.simulationId)
	// The requesting view reads the returned state itself, so nothing is broadcast that another view could answer with a new simulation.
	assert.deepEqual(browserMock.sentMessages, [])
})

test('adding the recipient to the address book clears the send-to-non-contact warning without simulating again', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	assert.equal(hasNotInAddressBookWarning(getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)), true)
	assert.equal(hasNotInAddressBookWarning(getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState)), true)
	fakeSafeContract.requestedRpcMethods.length = 0

	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	const pendingTransactionAfter = getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)
	assert.equal(hasNotInAddressBookWarning(pendingTransactionAfter), false)
	assert.equal(pendingTransactionAfter.quarantine, false)
	const stackTransactionAfter = getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState)
	assert.equal(hasNotInAddressBookWarning(stackTransactionAfter), false)
	assert.equal(stackTransactionAfter.quarantine, false)
})

test('real simulation refreshes still simulate the confirmation and the stack again', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	const stackBefore = await getStoredStackVisualisation()
	fakeSafeContract.requestedRpcMethods.length = 0

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
	fakeSafeContract.requestedRpcMethods.length = 0

	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
	assert.equal((await getStoredStackVisualisation()).stored.simulationId, stackBefore.stored.simulationId + 1)
})

// Runs the injected write once, in the middle of the metadata refresh, when the address book is read to resolve names.
function runOnceDuringAddressBookLookup(concurrentWrite: () => Promise<void>) {
	let hasRun = false
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		const requestsAddressBook = keys === 'userAddressBookEntriesV3' || (Array.isArray(keys) && keys.includes('userAddressBookEntriesV3'))
		if (requestsAddressBook && !hasRun) {
			hasRun = true
			await concurrentWrite()
		}
		return readStoredItems()
	})
}

// Stored timestamps have second precision, so the newer simulation keeps the conducted timestamp and only differs by its block.
test('a confirmation re-simulated on a newer block during a metadata refresh is not replaced by the re-labelled older simulation', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	const newerBlockNumber = (await getStoredPendingTransactionVisualisation()).simulationState.blockNumber + 1n
	runOnceDuringAddressBookLookup(async () => {
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') return undefined
			const data = current.popupVisualisation.data
			return { ...current, popupVisualisation: { ...current.popupVisualisation, data: { ...data, simulationState: { ...data.simulationState, blockNumber: newerBlockNumber } } } }
		})
	})

	// The stack re-labelling is skipped so that only the confirmation's metadata lookups read the address book.
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined, { visualisation: { async update() { return undefined } } })
	browserMock.setStorageGetHandler(undefined)

	const pendingAfter = await getStoredPendingTransactionVisualisation()
	assert.equal(pendingAfter.simulationState.blockNumber, newerBlockNumber)
	assert.notEqual(getLastVisualizedTransaction(pendingAfter.visualizedSimulationState).transaction.to?.name, recipientContact.name)
})

test('a stack simulation stored during a metadata refresh is not replaced by the re-labelled older simulation', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	const { stored: storedBefore } = await getStoredStackVisualisation()
	const newerSimulationId = storedBefore.simulationId + 1
	runOnceDuringAddressBookLookup(async () => {
		await updatePopupVisualisationWithCallBack(async (current) => ({ ...current, simulationId: newerSimulationId }))
	})

	await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)
	browserMock.setStorageGetHandler(undefined)

	const { stored: storedAfter } = await getStoredStackVisualisation()
	assert.equal(storedAfter.simulationId, newerSimulationId)
	assert.notEqual(getLastVisualizedTransaction(storedAfter.visualizedSimulationState).transaction.to?.name, recipientContact.name)
})

test('a confirmation resolved during a metadata refresh sends no pending-transaction dialog update', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	runOnceDuringAddressBookLookup(async () => {
		await removePendingTransactionOrMessage(uniqueRequestIdentifier)
	})
	browserMock.sentMessages.length = 0

	// The stack re-labelling is skipped so that only the confirmation's metadata lookups read the address book.
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined, { visualisation: { async update() { return undefined } } })
	browserMock.setStorageGetHandler(undefined)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), false)
})

async function updateStoredStackVisualisation(update: (stored: CompleteVisualizedSimulation) => CompleteVisualizedSimulation) {
	await updatePopupVisualisationWithCallBack(async (stored) => update(stored))
	return await getPopupVisualisationState()
}

test('a stack simulation of another chain is not re-labelled with the current chain metadata', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	const otherChainVisualisation = await updateStoredStackVisualisation((stored) => {
		if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated stack visualisation')
		const simulationState = stored.simulationState.value
		return { ...stored, simulationState: { kind: 'simulated', value: { ...simulationState, rpcNetwork: { ...simulationState.rpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } } } }
	})
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])

	await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)

	assert.deepEqual(await getPopupVisualisationState(), otherChainVisualisation)
})

test('pending, failed and invalidated stack visualisations are not re-labelled', async () => {
	const unsettledStates: readonly Pick<CompleteVisualizedSimulation, 'simulationUpdatingState' | 'simulationResultState'>[] = [
		{ simulationUpdatingState: 'updating', simulationResultState: 'done' },
		{ simulationUpdatingState: 'failed', simulationResultState: 'done' },
		{ simulationUpdatingState: 'done', simulationResultState: 'invalid' },
	]
	for (const unsettledState of unsettledStates) {
		await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
		const unsettledVisualisation = await updateStoredStackVisualisation((stored) => ({ ...stored, ...unsettledState }))
		await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])

		await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)

		assert.deepEqual(await getPopupVisualisationState(), unsettledVisualisation)
	}
})

function recordStoredVisualisationWrites() {
	const storedVisualisationWrites: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const { popupVisualisation } = items
		if (popupVisualisation !== undefined) storedVisualisationWrites.push(popupVisualisation)
		writeStoredItems()
	})
	return storedVisualisationWrites
}

test('a re-label aborted by a newer refresh during its metadata lookups stores nothing', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	const storedVisualisationWrites = recordStoredVisualisationWrites()
	let abortingRefresh: Promise<void> | undefined
	// publishFailedPopupVisualisation aborts the shared controller at once and then waits for the re-label to release the simulation semaphore.
	runOnceDuringAddressBookLookup(async () => {
		abortingRefresh = publishFailedPopupVisualisation()
	})

	await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)
	await abortingRefresh
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.equal(storedVisualisationWrites.length, 1)
	assert.equal(CompleteVisualizedSimulation.parse(storedVisualisationWrites[0]).simulationUpdatingState, 'failed')
})

test('a re-label after a failed refresh aborted the shared controller still stores its names', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await publishFailedPopupVisualisation()
	// Direct refreshes such as stack imports store a new simulation without replacing the aborted shared controller.
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])

	await refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState).transaction.to?.name, recipientContact.name)
})

test('a re-label waiting for the simulation semaphore is cancelled by a failure refresh requested meanwhile', async () => {
	await openSimulationModeConfirmationSendingEtherToUnknownRecipient()
	await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])
	const queuedRelabelRpcMethods: string[] = []
	const queuedRelabelEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async getChainId() { return fakeRpcNetwork.chainId },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
			queuedRelabelRpcMethods.push(rpcRequest.method)
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const storedVisualisationWrites = recordStoredVisualisationWrites()
	let reachLookup: (() => void) | undefined
	const runningRelabelReachedLookup = new Promise<void>((resolve) => { reachLookup = resolve })
	let releaseLookup: (() => void) | undefined
	const runningRelabelLookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve })
	runOnceDuringAddressBookLookup(async () => {
		reachLookup?.()
		await runningRelabelLookupReleased
	})

	// The first re-label holds the simulation semaphore inside its address-book lookup while the second one queues behind it.
	const runningRelabel = refreshPopupVisualisationMetadataForOpenConsumer(simulator.ethereum, simulator.tokenPriceService)
	await runningRelabelReachedLookup
	const queuedRelabel = refreshPopupVisualisationMetadataForOpenConsumer(queuedRelabelEthereum, simulator.tokenPriceService)
	const failureRefresh = publishFailedPopupVisualisation()
	releaseLookup?.()
	await Promise.all([runningRelabel, queuedRelabel, failureRefresh])
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(storedVisualisationWrites.map((write) => CompleteVisualizedSimulation.parse(write).simulationUpdatingState), ['failed'])
	assert.deepEqual(queuedRelabelRpcMethods, [])
})

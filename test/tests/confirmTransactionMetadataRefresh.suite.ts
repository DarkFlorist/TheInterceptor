import * as assert from 'assert'
import { test } from 'bun:test'
import { publishFailedPopupVisualisation, relabelPopupVisualisation, updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import { getPopupVisualisationState, removePendingTransactionOrMessage, updatePopupVisualisationWithCallBack } from '../../app/ts/background/storageVariables.js'
import type { SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { CompleteVisualizedSimulation, type SignedMessageTransaction, type SimulatedAndVisualizedTransaction, type VisualizedSimulationState, type WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { last } from '../../app/ts/utils/array.js'
import type { UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import { isNewBlockAbort } from '../../app/ts/utils/errors.js'
import { keccak256, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { activeAddress, browserMock, created, createSafeAddressBookEntry, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, oldTimestamp, recipientAddress, simulator, uniqueRequestIdentifier, withSilencedConsole, type RuntimeMessage, type StorageKeys } from './confirmTransactionTestHarness.js'

// Loaded after the harness installs the extension globals that the popup handler dependencies require at import time.
const { addOrModifyAddressBookEntry, changePreSimulationBlockTimeManipulation, refreshPopupConfirmTransactionMetadata, removeAddressBookEntry, setEnsNameForHash } = await import('../../app/ts/background/popupMessageHandlers.js')
const { publishAddressBookChangeAndRelabelSimulations } = await import('../../app/ts/background/addressBookChangePublication.js')
const { refreshConfirmTransactionSimulation, relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
const { createWatchAssetResolutionDependencies } = await import('../../app/ts/background/windows/watchAsset.js')
const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')

const simulationServicesOwner: SimulationServicesOwner = { getCurrent: () => simulator, reset: () => simulator }

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

async function storeSimulationModeSettings(userAddressBookEntries: readonly AddressBookEntry[]) {
	await modules.browserStorageLocalSet({
		simulationMode: true,
		activeRpcNetwork: fakeRpcNetwork,
		makeCurrentAddressRich: false,
		userAddressBookEntriesV3: userAddressBookEntries,
	})
}

// Simulates the stack and a pending confirmation that both send ether to the recipient, which is not in the address book unless given.
async function openSimulationModeConfirmationSendingEther(userAddressBookEntries: readonly AddressBookEntry[] = [senderAddressBookEntry]) {
	await storeSimulationModeSettings(userAddressBookEntries)
	await storeStackSendingEtherToRecipient()
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [sendEtherPendingTransaction] })
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
}

const addRecipientContactWithoutBroadcast = async () => await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])

function clearObservedRpcMethodsAndMessages() {
	fakeSafeContract.requestedRpcMethods.length = 0
	browserMock.sentMessages.length = 0
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

const getRecipientName = (visualizedSimulationState: VisualizedSimulationState) => getLastVisualizedTransaction(visualizedSimulationState).transaction.to?.name

async function getStoredPendingTransactionVisualisation() {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	return getSimulatedPendingTransaction(pending)
}

async function getStoredStackVisualisation() {
	const stored = await getPopupVisualisationState()
	if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated stack visualisation')
	return { stored, simulationState: stored.simulationState.value }
}

async function getStoredRecipientNames() {
	return {
		stack: getRecipientName((await getStoredStackVisualisation()).stored.visualizedSimulationState),
		confirmation: getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState),
	}
}

async function waitUntil(condition: () => boolean, description: string) {
	const deadline = Date.now() + 2_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${ description }`)
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

// A gate a test opens once: an async step awaits promise until the test calls resolve.
function createDeferred() {
	let resolveDeferred: () => void = () => undefined
	const promise = new Promise<void>((resolve) => { resolveDeferred = resolve })
	return { promise, resolve: () => resolveDeferred() }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number) {
	return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), milliseconds) })])
}

const countSentMessages = (method: string) => browserMock.sentMessages.filter((message) => message.method === method).length

// popup_simulationsRelabelled is sent once the background re-label has settled.
async function publishAddressBookChangeAndWaitForRelabel() {
	await publishAddressBookChangeAndRelabelSimulations(simulator)
	await waitUntil(() => countSentMessages('popup_simulationsRelabelled') >= 1, 'the re-label notification')
}

type RecipientNames = Awaited<ReturnType<typeof getStoredRecipientNames>>

// Acts as an open simulation view: whenever it is notified of an address-book change or a finished re-label, it reads the recipient names the stored simulations then show.
function observeStoredNamesAtNotifications() {
	const namesAtAddressBookChange: RecipientNames[] = []
	const namesAtRelabel: RecipientNames[] = []
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_addressBookEntriesChanged') namesAtAddressBookChange.push(await getStoredRecipientNames())
		if (message.method === 'popup_simulationsRelabelled') namesAtRelabel.push(await getStoredRecipientNames())
		return undefined
	})
	return { namesAtAddressBookChange, namesAtRelabel }
}

const requestsStorageKey = (keys: StorageKeys, key: string) => keys === key || (Array.isArray(keys) && keys.includes(key))
const ADDRESS_BOOK_AND_ENS_STORAGE_KEYS = ['userAddressBookEntriesV3', 'ensLabelHashes', 'ensNameHashes']

// Once the next address-book or ENS change is stored, every address-book lookup waits until released, which stalls the re-label that follows the change.
function stallAddressBookLookupsAfterNextChange() {
	let isChangeStored = false
	const lookupsReleased = createDeferred()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (ADDRESS_BOOK_AND_ENS_STORAGE_KEYS.some((key) => key in items)) isChangeStored = true
	})
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (isChangeStored && requestsStorageKey(keys, 'userAddressBookEntriesV3')) await lookupsReleased.promise
		return readStoredItems()
	})
	return lookupsReleased.resolve
}

// Runs an address-book change while the background re-label is stalled and checks that its reply and the address-book broadcast do not wait for the re-label. Returns the recipient names shown at each notification once the re-label settled.
async function changeAddressBookWhileRelabelIsStalled(change: () => Promise<unknown>) {
	clearObservedRpcMethodsAndMessages()
	const observedNames = observeStoredNamesAtNotifications()
	const releaseLookups = stallAddressBookLookupsAfterNextChange()
	try {
		assert.equal(await settlesWithin(change(), 1_000), true, 'the change must not wait for the stalled re-label')
		await waitUntil(() => observedNames.namesAtAddressBookChange.length >= 1, 'the address-book change broadcast')
		assert.equal(observedNames.namesAtRelabel.length, 0)
	} finally {
		releaseLookups()
	}
	await waitUntil(() => observedNames.namesAtRelabel.length >= 1, 'the re-label notification')
	browserMock.setRuntimeMessageHandler(undefined)
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)
	assert.equal(countSentMessages('popup_addressBookEntriesChanged'), 1)
	assert.equal(countSentMessages('popup_simulationsRelabelled'), 1)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	return observedNames
}

const hasNotInAddressBookWarning = (transaction: SimulatedAndVisualizedTransaction) => transaction.quarantineReasons.some((reason) => reason.includes(NOT_IN_ADDRESS_BOOK_WARNING))

// The stack re-label as publishAddressBookChangeAndRelabelSimulations runs it, where cancellation by a newer refresh is expected.
async function relabelStoredStack(ethereum = simulator.ethereum) {
	try {
		await relabelPopupVisualisation(ethereum, simulator.tokenPriceService)
	} catch (error: unknown) {
		if (!isNewBlockAbort(error)) throw error
	}
}

test('address-book changes re-label the stored confirmation and stack without simulating again or publishing simulation state', async () => {
	await openSimulationModeConfirmationSendingEther()
	const pendingBefore = await getStoredPendingTransactionVisualisation()
	const stackBefore = await getStoredStackVisualisation()
	assert.notEqual(getRecipientName(pendingBefore.visualizedSimulationState), recipientContact.name)
	assert.notEqual(getRecipientName(stackBefore.stored.visualizedSimulationState), recipientContact.name)
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()

	await publishAddressBookChangeAndWaitForRelabel()

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	const pendingAfter = await getStoredPendingTransactionVisualisation()
	assert.equal(getRecipientName(pendingAfter.visualizedSimulationState), recipientContact.name)
	assert.equal(pendingAfter.simulationId, pendingBefore.simulationId)
	assert.equal(pendingAfter.simulationState.simulationConductedTimestamp.getTime(), pendingBefore.simulationState.simulationConductedTimestamp.getTime())
	const stackAfter = await getStoredStackVisualisation()
	assert.equal(getRecipientName(stackAfter.stored.visualizedSimulationState), recipientContact.name)
	assert.equal(stackAfter.stored.simulationId, stackBefore.stored.simulationId)
	assert.equal(stackAfter.simulationState.simulationConductedTimestamp.getTime(), stackBefore.simulationState.simulationConductedTimestamp.getTime())
	// The change is broadcast once and the finished re-label is announced. No popup_simulation_state_changed is published, which FetchSimulationStack would answer by requesting new simulations.
	assert.deepEqual(browserMock.sentMessages.map((message) => message.method), ['popup_addressBookEntriesChanged', 'popup_simulationsRelabelled'])
})

test('adding the recipient to the address book clears the send-to-non-contact warning without simulating again', async () => {
	await openSimulationModeConfirmationSendingEther()
	assert.equal(hasNotInAddressBookWarning(getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)), true)
	assert.equal(hasNotInAddressBookWarning(getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState)), true)
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()

	await publishAddressBookChangeAndWaitForRelabel()

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	const pendingTransactionAfter = getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)
	assert.equal(hasNotInAddressBookWarning(pendingTransactionAfter), false)
	assert.equal(pendingTransactionAfter.quarantine, false)
	const stackTransactionAfter = getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState)
	assert.equal(hasNotInAddressBookWarning(stackTransactionAfter), false)
	assert.equal(stackTransactionAfter.quarantine, false)
})

const relabelledNames = { stack: recipientContact.name, confirmation: recipientContact.name }

test('saving an address-book entry replies and broadcasts at once, then announces the re-labelled simulations', async () => {
	await openSimulationModeConfirmationSendingEther()

	const { namesAtAddressBookChange, namesAtRelabel } = await changeAddressBookWhileRelabelIsStalled(async () => {
		assert.deepEqual(await addOrModifyAddressBookEntry(simulationServicesOwner, new Map(), { method: 'popup_addOrModifyAddressBookEntry', data: recipientContact }), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
	})

	assert.notDeepEqual(namesAtAddressBookChange, [relabelledNames])
	assert.deepEqual(namesAtRelabel, [relabelledNames])
})

test('removing an address-book entry replies and broadcasts at once, then announces the re-labelled simulations', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, recipientContact])
	assert.deepEqual(await getStoredRecipientNames(), relabelledNames)

	const { namesAtAddressBookChange, namesAtRelabel } = await changeAddressBookWhileRelabelIsStalled(async () => await removeAddressBookEntry(simulationServicesOwner, new Map(), {
		method: 'popup_removeAddressBookEntry',
		data: { address: recipient, addressBookCategory: 'My Contacts', chainId: fakeRpcNetwork.chainId },
	}))

	assert.deepEqual(namesAtAddressBookChange, [relabelledNames])
	assert.notEqual(namesAtRelabel[0]?.stack, recipientContact.name)
	assert.notEqual(namesAtRelabel[0]?.confirmation, recipientContact.name)
})

test('setting an ENS name replies and broadcasts at once, then announces the re-labelled simulations', async () => {
	await openSimulationModeConfirmationSendingEther()
	// Stored without a broadcast, so only the re-label that follows the ENS edit can show this name.
	await addRecipientContactWithoutBroadcast()
	const label = 'interceptor'

	const { namesAtAddressBookChange, namesAtRelabel } = await changeAddressBookWhileRelabelIsStalled(async () => await setEnsNameForHash(simulationServicesOwner, { method: 'popup_setEnsNameForHash', data: { type: 'labelHash', nameHash: BigInt(keccak256(stringToBytes(label))), name: label } }))

	assert.notDeepEqual(namesAtAddressBookChange, [relabelledNames])
	assert.deepEqual(namesAtRelabel, [relabelledNames])
})

test('changing a Safe simulation signer replies and broadcasts at once, then announces the re-labelled simulations', async () => {
	const safeAddress = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, createSafeAddressBookEntry({ address: safeAddress, useAsActiveAddress: false })])
	// Stored without a broadcast, so only the re-label that follows the signer change can show this name.
	await addRecipientContactWithoutBroadcast()

	const { namesAtAddressBookChange, namesAtRelabel } = await changeAddressBookWhileRelabelIsStalled(async () => {
		// The fake chain reports code for every address while the signer change validates the Safe; the re-label's lookups only start after the change is stored.
		fakeSafeContract.ownerCode = '0x01'
		const reply = await modules.setSafeSimulationSigner(simulationServicesOwner, new Map(), {
			method: 'popup_setSafeSimulationSigner',
			data: { chainId: fakeRpcNetwork.chainId, safeAddress, safeSimulationSignerAddress: undefined },
		})
		fakeSafeContract.ownerCode = '0x'
		assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	})

	assert.notDeepEqual(namesAtAddressBookChange, [relabelledNames])
	assert.deepEqual(namesAtRelabel, [relabelledNames])
})

test('adding a watched asset publishes the change at once, then announces the re-labelled simulations', async () => {
	await openSimulationModeConfirmationSendingEther()
	const watchAssetResolution = createWatchAssetResolutionDependencies(simulationServicesOwner, new Map())

	// As resolveWatchAsset does for an approved asset: store the address-book change, then publish it before closing the dialog and releasing its lock.
	const { namesAtAddressBookChange, namesAtRelabel } = await changeAddressBookWhileRelabelIsStalled(async () => {
		await watchAssetResolution.updateAddressBook((entries) => [...entries, recipientContact])
		await watchAssetResolution.publishAddressBookChanged()
	})

	assert.notDeepEqual(namesAtAddressBookChange, [relabelledNames])
	assert.deepEqual(namesAtRelabel, [relabelledNames])
})

function getLastConfirmationDialogUpdates(sentMessages: readonly RuntimeMessage[]) {
	const pendingTransactionsUpdate = sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
	const dialogUpdate = sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog')
	return {
		pendingTransactions: UpdateConfirmTransactionDialogPendingTransactions.parse({ method: pendingTransactionsUpdate?.method, data: pendingTransactionsUpdate?.data }).data.pendingTransactionAndSignableMessages,
		visualizedSimulatorState: UpdateConfirmTransactionDialog.parse({ method: dialogUpdate?.method, data: dialogUpdate?.data }).data.visualizedSimulatorState,
	}
}

test('a confirmation dialog answering the change and re-label notifications ends with the re-labelled confirmation and stack without a simulation', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	// As ConfirmTransaction.tsx does, the open dialog asks for its metadata on both notifications.
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_addressBookEntriesChanged' || message.method === 'popup_simulationsRelabelled') await refreshPopupConfirmTransactionMetadata(simulator.ethereum, undefined)
		return undefined
	})

	await publishAddressBookChangeAndWaitForRelabel()
	browserMock.setRuntimeMessageHandler(undefined)

	const { pendingTransactions, visualizedSimulatorState } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getRecipientName(getSimulatedPendingTransaction(pendingTransactions[0]).visualizedSimulationState), recipientContact.name)
	assert.equal(getRecipientName(visualizedSimulatorState.visualizedSimulationState), recipientContact.name)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_simulation_state_changed'), false)
})

test('a confirmation dialog refresh started before the re-label but sent last still shows the re-labelled names', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	// The refresh answering the address-book change waits for an eth_blockNumber reply, as when no block is cached, until the refresh answering the re-label has been sent.
	const blockNumberReleased = createDeferred()
	const stallingEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
			if (rpcRequest.method === 'eth_blockNumber') await blockNumberReleased.promise
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	let refreshAfterAddressBookChange: Promise<void> | undefined
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_addressBookEntriesChanged') refreshAfterAddressBookChange = refreshPopupConfirmTransactionMetadata(stallingEthereum, undefined)
		if (message.method === 'popup_simulationsRelabelled') {
			await refreshPopupConfirmTransactionMetadata(simulator.ethereum, undefined)
			blockNumberReleased.resolve()
		}
		return undefined
	})

	await publishAddressBookChangeAndWaitForRelabel()
	await refreshAfterAddressBookChange
	browserMock.setRuntimeMessageHandler(undefined)

	assert.equal(countSentMessages('popup_update_confirm_transaction_dialog_pending_transactions'), 2)
	const { pendingTransactions, visualizedSimulatorState } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getRecipientName(getSimulatedPendingTransaction(pendingTransactions[0]).visualizedSimulationState), recipientContact.name)
	assert.equal(getRecipientName(visualizedSimulatorState.visualizedSimulationState), recipientContact.name)
})

const personalSignRequestParameters = { method: 'personal_sign' as const, params: ['0x48656c6c6f', recipient] as const }

// Stores simulated personal_sign requests for the recipient's account, visualised with the address book stored at that time.
async function storeSimulatedPersonalSignMessages(requestIdentifiers: readonly UniqueRequestIdentifier[]) {
	const pendingMessages = await Promise.all(requestIdentifiers.map(async (requestIdentifier, index) => {
		const signedMessageTransaction: SignedMessageTransaction = {
			website,
			created,
			fakeSignedFor: sender,
			activeAddress: sender,
			originalRequestParameters: personalSignRequestParameters,
			request: { method: 'personal_sign', params: [...personalSignRequestParameters.params], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: requestIdentifier },
			simulationMode: true,
			messageIdentifier: BigInt(index + 1),
		}
		return {
			type: 'SignableMessage' as const,
			popupOrTabId: { type: 'popup' as const, id: 1 },
			originalRequestParameters: personalSignRequestParameters,
			simulationMode: true,
			uniqueRequestIdentifier: requestIdentifier,
			signedMessageTransaction,
			created,
			website,
			activeAddress: sender,
			approvalStatus: { status: 'WaitingForUser' as const },
			transactionOrMessageCreationStatus: 'Simulated' as const,
			visualizedPersonalSignRequest: await craftPersonalSignPopupMessage(simulator.ethereum, undefined, signedMessageTransaction, fakeRpcNetwork),
		}
	}))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: pendingMessages })
	return await modules.getPendingTransactionsAndMessages()
}

function getSimulatedSignableMessage(pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage | undefined) {
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated signable message')
	return pending
}

function getSignedAccountName(pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage | undefined) {
	const visualizedPersonalSignRequest = getSimulatedSignableMessage(pending).visualizedPersonalSignRequest
	return 'account' in visualizedPersonalSignRequest ? visualizedPersonalSignRequest.account.name : undefined
}

test('a confirmation dialog refresh sends a displayed signable message visualised with the new names without storing them', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry])
	const storedMessages = await storeSimulatedPersonalSignMessages([uniqueRequestIdentifier])
	assert.notEqual(getSignedAccountName(storedMessages[0]), recipientContact.name)
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, undefined)

	const { pendingTransactions } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getSignedAccountName(pendingTransactions[0]), recipientContact.name)
	// Address-book re-labels do not cover signable messages, so only this dialog update carries the new names.
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), storedMessages)
})

test('a signable message resolved while the dialog refresh visualises it leaves the next pending message unchanged', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry])
	const nextRequest = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	const [, nextStoredMessage] = await storeSimulatedPersonalSignMessages([uniqueRequestIdentifier, nextRequest])
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	runOnceDuringAddressBookLookup(async () => {
		await removePendingTransactionOrMessage(uniqueRequestIdentifier)
	})

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, undefined)
	browserMock.setStorageGetHandler(undefined)

	const { pendingTransactions } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(pendingTransactions.length, 1)
	assert.deepEqual(getSimulatedSignableMessage(pendingTransactions[0]).visualizedPersonalSignRequest, getSimulatedSignableMessage(nextStoredMessage).visualizedPersonalSignRequest)
	assert.notEqual(getSignedAccountName(pendingTransactions[0]), recipientContact.name)
})

test('an unexpected re-label failure is reported and the re-label is still announced', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items) throw new Error('Pending confirmation storage unavailable')
		writeStoredItems()
	})

	await withSilencedConsole(async () => await publishAddressBookChangeAndWaitForRelabel())
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(browserMock.sentMessages.map((message) => message.method), ['popup_addressBookEntriesChanged', 'popup_UnexpectedErrorOccured', 'popup_simulationsRelabelled'])
	assert.equal(getRecipientName((await getStoredStackVisualisation()).stored.visualizedSimulationState), recipientContact.name)
})

test('real simulation refreshes still simulate the confirmation and the stack again', async () => {
	await openSimulationModeConfirmationSendingEther()
	const stackBefore = await getStoredStackVisualisation()
	const pendingBefore = await getStoredPendingTransactionVisualisation()
	fakeSafeContract.requestedRpcMethods.length = 0

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
	assert.notEqual((await getStoredPendingTransactionVisualisation()).simulationId, pendingBefore.simulationId)
	fakeSafeContract.requestedRpcMethods.length = 0

	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
	assert.equal((await getStoredStackVisualisation()).stored.simulationId, stackBefore.stored.simulationId + 1)
})

// Runs the injected write once, in the middle of a re-label, when the address book is read to resolve names.
function runOnceDuringAddressBookLookup(concurrentWrite: () => Promise<void>) {
	let hasRun = false
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (requestsStorageKey(keys, 'userAddressBookEntriesV3') && !hasRun) {
			hasRun = true
			await concurrentWrite()
		}
		return readStoredItems()
	})
}

// Stored timestamps have second precision, so a re-simulation on the same block within the same second, such as after a gas limit edit, keeps both the block number and the conducted timestamp; only its simulation run id tells it apart.
test('a confirmation re-simulated on the same block within the same second during a re-label is not replaced by the re-labelled older run', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const relabelledRun = await getStoredPendingTransactionVisualisation()
	const newerRunId = getDefined(relabelledRun.simulationId, 'confirmation simulation id') + 1
	const editedGasLimit = 30_000n
	runOnceDuringAddressBookLookup(async () => {
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') return undefined
			const transactionToSimulate = { ...current.transactionToSimulate, transaction: { ...current.transactionToSimulate.transaction, gas: editedGasLimit } }
			return { ...current, transactionToSimulate, popupVisualisation: { ...current.popupVisualisation, data: { ...current.popupVisualisation.data, simulationId: newerRunId, transactionToSimulate } } }
		})
	})

	await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	browserMock.setStorageGetHandler(undefined)

	const storedRun = await getStoredPendingTransactionVisualisation()
	assert.equal(storedRun.simulationState.blockNumber, relabelledRun.simulationState.blockNumber)
	assert.equal(storedRun.simulationState.simulationConductedTimestamp.getTime(), relabelledRun.simulationState.simulationConductedTimestamp.getTime())
	assert.equal(storedRun.simulationId, newerRunId)
	assert.equal(storedRun.transactionToSimulate.success && storedRun.transactionToSimulate.transaction.gas, editedGasLimit)
	assert.notEqual(getRecipientName(storedRun.visualizedSimulationState), recipientContact.name)
})

test('a stack simulation stored during a re-label is not replaced by the re-labelled older simulation', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const { stored: storedBefore } = await getStoredStackVisualisation()
	const newerSimulationId = storedBefore.simulationId + 1
	runOnceDuringAddressBookLookup(async () => {
		await updatePopupVisualisationWithCallBack(async (current) => ({ ...current, simulationId: newerSimulationId }))
	})

	await relabelStoredStack()
	browserMock.setStorageGetHandler(undefined)

	const { stored: storedAfter } = await getStoredStackVisualisation()
	assert.equal(storedAfter.simulationId, newerSimulationId)
	assert.notEqual(getRecipientName(storedAfter.visualizedSimulationState), recipientContact.name)
})

test('a stack invalidation stored under the re-labelled run\'s id during a re-label is not replaced by the re-labelled run', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const { stored: storedBefore } = await getStoredStackVisualisation()
	// updatePopupVisualisationIfNeeded derives its invalidation id from the state it read before a simulation stored that id, so the invalidation keeps the run's id.
	runOnceDuringAddressBookLookup(async () => {
		await updatePopupVisualisationWithCallBack(async (current) => ({ ...current, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
	})

	await relabelStoredStack()
	browserMock.setStorageGetHandler(undefined)

	const { stored: storedAfter } = await getStoredStackVisualisation()
	assert.equal(storedAfter.simulationId, storedBefore.simulationId)
	assert.equal(storedAfter.simulationResultState, 'invalid')
	assert.notEqual(getRecipientName(storedAfter.visualizedSimulationState), recipientContact.name)
})

test('a confirmation resolved during a re-label is not stored again and no dialog update is sent', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	runOnceDuringAddressBookLookup(async () => {
		await removePendingTransactionOrMessage(uniqueRequestIdentifier)
	})
	browserMock.sentMessages.length = 0

	await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	browserMock.setStorageGetHandler(undefined)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(browserMock.sentMessages, [])
})

async function updateStoredConfirmationVisualisation(update: (data: ReturnType<typeof getSimulatedPendingTransaction>) => ReturnType<typeof getSimulatedPendingTransaction>) {
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
		if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') throw new Error('Expected a simulated pending transaction')
		return { ...current, popupVisualisation: { statusCode: 'success', data: update(current.popupVisualisation.data) } }
	})
	return await modules.getPendingTransactionsAndMessages()
}

test('confirmations without a simulation run id or simulated on another chain are not re-labelled', async () => {
	const unprovableConfirmations: readonly { description: string, update: (data: ReturnType<typeof getSimulatedPendingTransaction>) => ReturnType<typeof getSimulatedPendingTransaction> }[] = [
		{ description: 'stored by a version without simulation run ids', update: ({ simulationId: _simulationId, ...data }) => data },
		{ description: 'simulated on another chain', update: (data) => ({ ...data, simulationState: { ...data.simulationState, rpcNetwork: { ...data.simulationState.rpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } } }) },
	]
	for (const { description, update } of unprovableConfirmations) {
		await openSimulationModeConfirmationSendingEther()
		const storedConfirmations = await updateStoredConfirmationVisualisation(update)
		await addRecipientContactWithoutBroadcast()

		await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)

		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), storedConfirmations, description)
	}
})

test('a confirmation re-label requested while another one is running waits for it, so the last one reads the latest address book', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	let pendingConfirmationReads = 0
	const runningRelabelReachedLookup = createDeferred()
	const runningRelabelLookupReleased = createDeferred()
	let hasHeldLookup = false
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		const requestedKeys = Array.isArray(keys) ? keys : [keys]
		if (requestedKeys.includes('pendingTransactionsAndMessages')) pendingConfirmationReads += 1
		if (requestedKeys.includes('userAddressBookEntriesV3') && !hasHeldLookup) {
			hasHeldLookup = true
			runningRelabelReachedLookup.resolve()
			await runningRelabelLookupReleased.promise
		}
		return readStoredItems()
	})

	const runningRelabel = relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	await runningRelabelReachedLookup.promise
	const pendingConfirmationReadsBeforeQueuedRelabel = pendingConfirmationReads
	const renamedRecipient = 'Renamed again'
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === recipient ? { ...entry, name: renamedRecipient } : entry))
	const queuedRelabel = relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	await new Promise((resolve) => setTimeout(resolve, 0))

	assert.equal(pendingConfirmationReads, pendingConfirmationReadsBeforeQueuedRelabel)
	runningRelabelLookupReleased.resolve()
	await Promise.all([runningRelabel, queuedRelabel])
	browserMock.setStorageGetHandler(undefined)

	assert.equal(getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState), renamedRecipient)
})

const simulateDisplayedConfirmation = async () => await refreshConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService, sender, true, uniqueRequestIdentifier, sendEtherWebsiteTransaction)

async function countAddressBookReadsOfConfirmationSimulation() {
	let addressBookReads = 0
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (requestsStorageKey(keys, 'userAddressBookEntriesV3')) addressBookReads += 1
		return readStoredItems()
	})
	await simulateDisplayedConfirmation()
	browserMock.setStorageGetHandler(undefined)
	return addressBookReads
}

test('a confirmation simulation whose name lookups overlap an address-book change returns its run with the new names', async () => {
	await openSimulationModeConfirmationSendingEther()
	const addressBookReadsPerSimulation = await countAddressBookReadsOfConfirmationSimulation()
	assert.equal(await countAddressBookReadsOfConfirmationSimulation(), addressBookReadsPerSimulation, 'a confirmation simulation must read the address book a fixed number of times')
	let relabel: Promise<void> | undefined
	let addressBookReads = 0
	// Every lookup of the simulation reads the address book from before the change, which is stored and re-labelled during the last lookup while the simulation still runs; the re-label cannot see that run until its caller stores it.
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (!requestsStorageKey(keys, 'userAddressBookEntriesV3')) return readStoredItems()
		addressBookReads += 1
		if (addressBookReads !== addressBookReadsPerSimulation) return readStoredItems()
		const addressBookBeforeChange = readStoredItems()
		await addRecipientContactWithoutBroadcast()
		relabel = relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
		return addressBookBeforeChange
	})

	const simulatedRun = await simulateDisplayedConfirmation()
	await relabel
	browserMock.setStorageGetHandler(undefined)

	if (simulatedRun?.statusCode !== 'success') throw new Error('Expected a successful confirmation simulation')
	assert.equal(getRecipientName(simulatedRun.data.visualizedSimulationState), recipientContact.name)
})

function recordPendingConfirmationWrites() {
	const pendingConfirmationWrites: unknown[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items) pendingConfirmationWrites.push(items.pendingTransactionsAndMessages)
		writeStoredItems()
	})
	return pendingConfirmationWrites
}

test('a confirmation re-label cancelled by a new simulation of the displayed request during its lookups stores nothing', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const pendingConfirmationWrites = recordPendingConfirmationWrites()
	// That new run is not stored here, so any write would come from the cancelled re-label.
	runOnceDuringAddressBookLookup(async () => {
		await simulateDisplayedConfirmation()
	})

	try {
		await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	} catch (error: unknown) {
		if (!isNewBlockAbort(error)) throw error
	}
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(pendingConfirmationWrites, [])
	assert.notEqual(getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState), recipientContact.name)
})

test('a confirmation simulation of another request during a re-label does not stop the displayed confirmation from being re-labelled', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const anotherRequest = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	// Such as a request appended behind the displayed one, which is simulated as soon as it is added.
	runOnceDuringAddressBookLookup(async () => {
		await refreshConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService, sender, true, anotherRequest, sendEtherWebsiteTransaction)
	})

	await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)
	browserMock.setStorageGetHandler(undefined)

	assert.equal(getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState), recipientContact.name)
})

async function updateStoredStackVisualisation(update: (stored: CompleteVisualizedSimulation) => CompleteVisualizedSimulation) {
	await updatePopupVisualisationWithCallBack(async (stored) => update(stored))
	return await getPopupVisualisationState()
}

// onlyIfNotAlreadyUpdating callers keep a simulation from the current block interval for its age alone, so their tests make the stored one older than that.
async function ageStoredStackSimulation() {
	return await updateStoredStackVisualisation((stored) => {
		if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated stack visualisation')
		return { ...stored, simulationState: { kind: 'simulated', value: { ...stored.simulationState.value, simulationConductedTimestamp: oldTimestamp } } }
	})
}

test('a stack simulation of another chain is not re-labelled with the current chain metadata', async () => {
	await openSimulationModeConfirmationSendingEther()
	const otherChainVisualisation = await updateStoredStackVisualisation((stored) => {
		if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated stack visualisation')
		const simulationState = stored.simulationState.value
		return { ...stored, simulationState: { kind: 'simulated', value: { ...simulationState, rpcNetwork: { ...simulationState.rpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } } } }
	})
	await addRecipientContactWithoutBroadcast()

	await relabelStoredStack()

	assert.deepEqual(await getPopupVisualisationState(), otherChainVisualisation)
})

test('pending, failed and invalidated stack visualisations are not re-labelled', async () => {
	const unsettledStates: readonly Pick<CompleteVisualizedSimulation, 'simulationUpdatingState' | 'simulationResultState'>[] = [
		{ simulationUpdatingState: 'updating', simulationResultState: 'done' },
		{ simulationUpdatingState: 'failed', simulationResultState: 'done' },
		{ simulationUpdatingState: 'done', simulationResultState: 'invalid' },
	]
	for (const unsettledState of unsettledStates) {
		await openSimulationModeConfirmationSendingEther()
		const unsettledVisualisation = await updateStoredStackVisualisation((stored) => ({ ...stored, ...unsettledState }))
		await addRecipientContactWithoutBroadcast()

		await relabelStoredStack()

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

test('a stack re-label aborted by a newer refresh during its metadata lookups stores nothing', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const storedVisualisationWrites = recordStoredVisualisationWrites()
	let abortingRefresh: Promise<void> | undefined
	// publishFailedPopupVisualisation aborts the shared controller at once and then waits for the re-label to release the simulation semaphore.
	runOnceDuringAddressBookLookup(async () => {
		abortingRefresh = publishFailedPopupVisualisation()
	})

	await relabelStoredStack()
	await abortingRefresh
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.equal(storedVisualisationWrites.length, 1)
	assert.equal(CompleteVisualizedSimulation.parse(storedVisualisationWrites[0]).simulationUpdatingState, 'failed')
})

test('a stack re-label after a failed refresh aborted the shared controller still stores its names', async () => {
	await openSimulationModeConfirmationSendingEther()
	await publishFailedPopupVisualisation()
	// Direct refreshes such as stack imports store a new simulation without replacing the aborted shared controller.
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	await addRecipientContactWithoutBroadcast()

	await relabelStoredStack()

	assert.equal(getRecipientName((await getStoredStackVisualisation()).stored.visualizedSimulationState), recipientContact.name)
})

test('a stack re-label waiting for the simulation semaphore is cancelled by a failure refresh requested meanwhile', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
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
	const runningRelabelReachedLookup = createDeferred()
	const runningRelabelLookupReleased = createDeferred()
	runOnceDuringAddressBookLookup(async () => {
		runningRelabelReachedLookup.resolve()
		await runningRelabelLookupReleased.promise
	})

	// The first re-label holds the simulation semaphore inside its address-book lookup while the second one queues behind it.
	const runningRelabel = relabelStoredStack()
	await runningRelabelReachedLookup.promise
	const queuedRelabel = relabelStoredStack(queuedRelabelEthereum)
	const failureRefresh = publishFailedPopupVisualisation()
	runningRelabelLookupReleased.resolve()
	await Promise.all([runningRelabel, queuedRelabel, failureRefresh])
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(storedVisualisationWrites.map((write) => CompleteVisualizedSimulation.parse(write).simulationUpdatingState), ['failed'])
	assert.deepEqual(queuedRelabelRpcMethods, [])
})

test('a block-time manipulation change during a stack re-label still simulates the stack again', async () => {
	await openSimulationModeConfirmationSendingEther()
	const storedBefore = await ageStoredStackSimulation()
	await addRecipientContactWithoutBroadcast()
	browserMock.setRuntimeMessageHandler(async (message) => message.method === 'popup_isSimulationVisualizerOpen' ? { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } } : undefined)
	const relabelReachedLookup = createDeferred()
	const relabelLookupReleased = createDeferred()
	runOnceDuringAddressBookLookup(async () => {
		relabelReachedLookup.resolve()
		await relabelLookupReleased.promise
	})

	// The re-label holds the simulation semaphore inside its address-book lookup while the block-time change asks for a refresh.
	const relabel = relabelStoredStack()
	await relabelReachedLookup.promise
	clearObservedRpcMethodsAndMessages()
	const blockTimeChange = changePreSimulationBlockTimeManipulation(simulator.ethereum, simulator.tokenPriceService, {
		method: 'popup_changePreSimulationBlockTimeManipulation',
		data: { blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } },
	})
	try {
		await waitUntil(() => browserMock.sentMessages.some((message) => message.method === 'popup_simulation_state_changed'), 'the block-time change to invalidate the stack')
	} finally {
		relabelLookupReleased.resolve()
	}
	await Promise.all([relabel, blockTimeChange])
	browserMock.setStorageGetHandler(undefined)
	browserMock.setRuntimeMessageHandler(undefined)

	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
	const { stored: storedAfter } = await getStoredStackVisualisation()
	assert.equal(storedAfter.simulationId > storedBefore.simulationId, true)
	assert.equal(storedAfter.simulationUpdatingState, 'done')
	assert.equal(storedAfter.simulationResultState, 'done')
})

test('a block-time manipulation change during a running stack simulation is skipped without cancelling it', async () => {
	await openSimulationModeConfirmationSendingEther()
	const storedBefore = await ageStoredStackSimulation()
	const countSimulateCalls = () => fakeSafeContract.requestedRpcMethods.filter((method) => method === 'eth_simulateV1').length
	// One stack simulation makes several eth_simulateV1 calls, so a second simulation shows up as calls made after the first one published its result.
	let simulateCallsWhenResultPublished: number | undefined
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_isSimulationVisualizerOpen') return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
		if (message.method === 'popup_simulation_state_changed' && isRecord(message.data) && CompleteVisualizedSimulation.parse(message.data.visualizedSimulatorState).simulationUpdatingState === 'done') simulateCallsWhenResultPublished ??= countSimulateCalls()
		return undefined
	})
	const simulationAbortControllers: AbortController[] = []
	const simulationReached = createDeferred()
	const simulationReleased = createDeferred()
	const stallingEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest, requestAbortController?: AbortController) {
			if (requestAbortController !== undefined) simulationAbortControllers.push(requestAbortController)
			if (rpcRequest.method === 'eth_simulateV1') {
				simulationReached.resolve()
				await simulationReleased.promise
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	clearObservedRpcMethodsAndMessages()

	// The stack simulation runs with the shared abort controller and stalls inside eth_simulateV1 while the block-time change asks for a refresh.
	const runningSimulation = updatePopupVisualisationIfNeeded(stallingEthereum, simulator.tokenPriceService)
	await simulationReached.promise
	try {
		const blockTimeChange = changePreSimulationBlockTimeManipulation(stallingEthereum, simulator.tokenPriceService, {
			method: 'popup_changePreSimulationBlockTimeManipulation',
			data: { blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } },
		})
		assert.equal(await settlesWithin(blockTimeChange, 1_000), true, 'the block-time change must be skipped while a simulation runs')
	} finally {
		simulationReleased.resolve()
	}
	await runningSimulation
	browserMock.setRuntimeMessageHandler(undefined)

	assert.notEqual(simulateCallsWhenResultPublished, undefined)
	assert.equal(countSimulateCalls(), simulateCallsWhenResultPublished)
	assert.equal(simulationAbortControllers.length > 0, true)
	assert.equal(simulationAbortControllers.some((abortController) => abortController.signal.aborted), false)
	const { stored: storedAfter } = await getStoredStackVisualisation()
	assert.equal(storedAfter.simulationId, storedBefore.simulationId + 1)
	assert.equal(storedAfter.simulationUpdatingState, 'done')
})

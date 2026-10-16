import * as assert from 'assert'
import { test } from 'bun:test'
import { publishFailedPopupVisualisation, relabelPopupVisualisation, updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import type { SimulationRunToRelabel } from '../../app/ts/background/simulationRelabel.js'
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
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { last } from '../../app/ts/utils/array.js'
import type { UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { isNewBlockAbort } from '../../app/ts/utils/errors.js'
import { keccak256, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { activeAddress, addressString, browserMock, created, createSafeAddressBookEntry, createSafeTx, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, oldTimestamp, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, simulator, uniqueRequestIdentifier, withSilencedConsole, type RuntimeMessage, type StorageKeys } from './confirmTransactionTestHarness.js'

// Loaded after the harness installs the extension globals that the popup handler dependencies require at import time.
const { addOrModifyAddressBookEntry, changePreSimulationBlockTimeManipulation, refreshPopupConfirmTransactionMetadata, removeAddressBookEntry, setEnsNameForHash } = await import('../../app/ts/background/popupMessageHandlers.js')
const { publishAddressBookChangeAndRelabelSimulations } = await import('../../app/ts/background/addressBookChangePublication.js')
const { getConfirmTransactionAbortController, refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
const { relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmationRelabel.js')
const { relabelStoredSimulation } = await import('../../app/ts/background/simulationRelabel.js')
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

// Returns the run without storing it, as a newer simulation of the displayed request does while it is still running.
const simulateDisplayedConfirmation = async () => await refreshConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService, sender, true, uniqueRequestIdentifier, sendEtherWebsiteTransaction)

async function countAddressBookReads(read: () => Promise<unknown>) {
	let addressBookReads = 0
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (requestsStorageKey(keys, 'userAddressBookEntriesV3')) addressBookReads += 1
		return readStoredItems()
	})
	await read()
	browserMock.setStorageGetHandler(undefined)
	return addressBookReads
}

const countAddressBookReadsOfDisplayedConfirmationRelabel = async () => await countAddressBookReads(async () => await relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService))

// Stores the settings and the stack without a confirmation, so the request's confirmation is opened by its first simulation run.
async function storeSimulationModeStackWithoutConfirmation() {
	await storeSimulationModeSettings([senderAddressBookEntry])
	await storeStackSendingEtherToRecipient()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
}

// Opens the request's confirmation as a website's eth_sendTransaction does, which stores the request's first simulation run; a confirmation of the request left by an earlier call is resolved first.
async function openConfirmationThroughFirstRun() {
	await removePendingTransactionOrMessage(uniqueRequestIdentifier)
	const reply = await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...sendEtherRequestParameters },
		{ kind: 'transaction', parameters: sendEtherRequestParameters },
		true,
		sender,
		website,
		new Map(),
	)
	assert.deepEqual(reply, { type: 'doNotReply' })
}

const resimulateDisplayedConfirmation = async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

// The confirmation runs that are stored once simulated: a request's first run, which no re-label can reach before it is stored, and a re-simulation of a confirmation whose earlier run is stored. open stores the state the run starts from.
const storedConfirmationRuns = [
	{ kind: 'a request\'s first confirmation run', open: storeSimulationModeStackWithoutConfirmation, simulateAndStore: openConfirmationThroughFirstRun },
	{ kind: 'a confirmation re-simulation', open: async () => await openSimulationModeConfirmationSendingEther(), simulateAndStore: resimulateDisplayedConfirmation },
]

// Runs simulateAndStore, which simulates the displayed confirmation and stores the run, while duringLastLookup runs inside the run's last address-book lookup, which still returns the address book from before. Returns how often the address book was read after that lookup returned: the run looks up nothing more, so these are the lookups of a catch-up re-label.
async function simulateAndStoreRunningDuringLastLookup(simulateAndStore: () => Promise<void>, duringLastLookup: () => Promise<void>) {
	// A first run also caches the metadata it looks up, which later runs read instead.
	await simulateAndStore()
	const lookupsPerRun = await countAddressBookReads(simulateAndStore)
	assert.equal(await countAddressBookReads(simulateAndStore), lookupsPerRun, 'a confirmation run must read the address book a fixed number of times')
	let addressBookReads = 0
	let addressBookReadsAfterLastLookup: number | undefined
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (!requestsStorageKey(keys, 'userAddressBookEntriesV3')) return readStoredItems()
		if (addressBookReadsAfterLastLookup !== undefined) {
			addressBookReadsAfterLastLookup += 1
			return readStoredItems()
		}
		addressBookReads += 1
		if (addressBookReads !== lookupsPerRun) return readStoredItems()
		const addressBookBeforeLastLookup = readStoredItems()
		await duringLastLookup()
		addressBookReadsAfterLastLookup = 0
		return addressBookBeforeLastLookup
	})
	await simulateAndStore()
	browserMock.setStorageGetHandler(undefined)
	return getDefined(addressBookReadsAfterLastLookup, 'the last address-book lookup of the run')
}

// Stores an address-book change and publishes it as the popup handlers do, then waits until the re-label that follows it has settled.
async function changeAddressBookAndWaitForItsRelabel(change: () => Promise<unknown>) {
	const relabelsBefore = countSentMessages('popup_simulationsRelabelled')
	await change()
	await publishAddressBookChangeAndRelabelSimulations(simulator)
	await waitUntil(() => countSentMessages('popup_simulationsRelabelled') > relabelsBefore, 'the re-label notification')
}

const nameRecipient = async (name: string) => await modules.updateUserAddressBookEntries((entries) => [...entries.filter((entry) => entry.address !== recipient), { ...recipientContact, name }])

const getStoredConfirmationRecipientName = async () => getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)

for (const { kind, open, simulateAndStore } of storedConfirmationRuns) {
	// The re-label that follows the change reaches only stored runs: it re-labels the run stored before, which the new run replaces, and before a request's first run is stored there is no run to re-label at all.
	test(`${ kind } that looked up names before an address-book change was published ends with the new names once stored`, async () => {
		await open()

		await simulateAndStoreRunningDuringLastLookup(simulateAndStore, async () => await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast))

		assert.equal(await getStoredConfirmationRecipientName(), recipientContact.name)
	})

	test(`a burst of address-book changes during ${ kind } is caught up with a single re-label once the run is stored`, async () => {
		const recipientNames = ['Renamed once', 'Renamed twice', 'Renamed three times']
		await open()

		const addressBookReadsAfterRun = await simulateAndStoreRunningDuringLastLookup(simulateAndStore, async () => {
			for (const name of recipientNames) await changeAddressBookAndWaitForItsRelabel(async () => await nameRecipient(name))
		})

		assert.equal(await getStoredConfirmationRecipientName(), last(recipientNames))
		const lookupsPerRelabel = await countAddressBookReadsOfDisplayedConfirmationRelabel()
		assert.notEqual(lookupsPerRelabel, 0)
		// The run looked up names once, and the changes add one re-label after it, not a re-label or a visualisation per change.
		assert.equal(addressBookReadsAfterRun, lookupsPerRelabel)
	})

	test(`${ kind } during which no address-book change was published is not re-labelled after it is stored`, async () => {
		const runsWithoutChange = [
			{ description: 'nothing else runs', duringLastLookup: async () => undefined },
			// Re-labels also run without a newly published change, such as another confirmation run's catch-up re-label.
			{ description: 're-labels run without an address-book change', duringLastLookup: async () => { await Promise.all([relabelStoredStack(), relabelDisplayedConfirmationSimulation(simulator.ethereum, simulator.tokenPriceService)]) } },
		]
		for (const { description, duringLastLookup } of runsWithoutChange) {
			await open()

			assert.equal(await simulateAndStoreRunningDuringLastLookup(simulateAndStore, duringLastLookup), 0, description)
		}
	})
}

test('a request\'s first run that finished its lookups before an address-book change was published, but is stored after the re-label ran, ends with the new names', async () => {
	await storeSimulationModeStackWithoutConfirmation()
	let isChangePublished = false
	// The change is published just before the first run is written to storage, so the re-label that follows it reads the confirmation still waiting for that run and has nothing to re-label.
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const { pendingTransactionsAndMessages } = items
		if (!isChangePublished && Array.isArray(pendingTransactionsAndMessages) && pendingTransactionsAndMessages.some((pending) => isRecord(pending) && pending.transactionOrMessageCreationStatus === 'Simulated')) {
			isChangePublished = true
			await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast)
		}
		writeStoredItems()
	})

	await openConfirmationThroughFirstRun()
	browserMock.setStorageSetHandler(undefined)

	assert.equal(isChangePublished, true)
	assert.equal(await getStoredConfirmationRecipientName(), recipientContact.name)
})

test('a confirmation re-simulation aborted by a newer simulation is not re-labelled for an address-book change published during it', async () => {
	await openSimulationModeConfirmationSendingEther()
	const storedRunBefore = await getStoredPendingTransactionVisualisation()
	let isRunAborted = false
	// Rejects requests whose abort controller was aborted, as the extension's RPC request handler does. At the run's first request made with its abort controller, an address-book change is published and a newer confirmation simulation aborts the run, as each new one aborts the shared controller.
	const abortingEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest, requestAbortController?: AbortController) {
			if (!isRunAborted && requestAbortController !== undefined && requestAbortController === getConfirmTransactionAbortController()) {
				await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast)
				requestAbortController.abort(NEW_BLOCK_ABORT)
				isRunAborted = true
			}
			if (requestAbortController?.signal.aborted) throw new Error(NEW_BLOCK_ABORT)
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	let addressBookReadsAfterAbort = 0
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (isRunAborted && requestsStorageKey(keys, 'userAddressBookEntriesV3')) addressBookReadsAfterAbort += 1
		return readStoredItems()
	})

	await modules.refreshPopupConfirmTransactionSimulation(abortingEthereum, simulator.tokenPriceService)
	browserMock.setStorageGetHandler(undefined)

	assert.equal(isRunAborted, true)
	assert.equal((await getStoredPendingTransactionVisualisation()).simulationId, storedRunBefore.simulationId)
	assert.equal(addressBookReadsAfterAbort, 0)
})

test('a confirmation re-simulation that a newer stored run supersedes is not re-labelled for an address-book change published during it', async () => {
	await openSimulationModeConfirmationSendingEther()
	// Stands in for a newer run of the request that was stored first: no run in this test is handed its id, and its later conducted timestamp makes the store keep it.
	const newerRunId = Number.MAX_SAFE_INTEGER

	const addressBookReadsAfterRun = await simulateAndStoreRunningDuringLastLookup(resimulateDisplayedConfirmation, async () => {
		await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast)
		await updateStoredConfirmationVisualisation((data) => ({ ...data, simulationId: newerRunId, simulationState: { ...data.simulationState, simulationConductedTimestamp: new Date('2100-01-01T00:00:00.000Z') } }))
	})

	assert.equal(addressBookReadsAfterRun, 0)
	assert.equal((await getStoredPendingTransactionVisualisation()).simulationId, newerRunId)
})

test('a Safe signer refresh blocked while a newer run is stored and an address-book change is published is not re-labelled for that change', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipient
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, sender, { to: recipient, value: 0n, input: new Uint8Array() }, fakeSafeContract.nonce)
	const existingSignature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [safeTestOwnerAddress, safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSignerAddresses: [safeSignerAddress] })])
	const tabId = uniqueRequestIdentifier.requestSocket.tabId
	await modules.updateTabState(tabId, (state) => ({ ...state, signerAccounts: [], activeSigningAddress: undefined, signerChain: fakeRpcNetwork.chainId }))
	// Executes the Safe transaction with one owner's signature, which the Safe's signer completes; with no signer connected, the confirmation opens blocked on it.
	const executionParameters = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(sender),
			to: addressString(sender),
			value: '0x0',
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(recipient), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), existingSignature]),
		}],
	})
	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...executionParameters },
		{ kind: 'transaction', parameters: executionParameters },
		false,
		sender,
		website,
		new Map(),
	), { type: 'doNotReply' })
	// Stands in for a newer run of the request that another call stores while the signer is validated; unlike a direct Safe execution in this harness, it visualises successfully, so a re-label of it would look up names.
	const newerRun = await simulateDisplayedConfirmation()
	if (newerRun?.statusCode !== 'success') throw new Error('Expected a successful confirmation simulation')
	// The signer connects, but its validation fails on the Safe's version, so the refresh persists only a new approval error.
	await modules.updateTabState(tabId, (state) => ({ ...state, signerAccounts: [safeSignerAddress], activeSigningAddress: safeSignerAddress }))
	fakeSafeContract.version = 'invalid-version'
	let isValidationOverlapped = false
	let isRefreshPersisted = false
	let addressBookReadsAfterPersist = 0
	fakeSafeContract.beforeVersionResponse = async () => {
		if (isValidationOverlapped) return
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			if (current.type !== 'Transaction') throw new Error('Expected a pending direct Safe execution')
			return { ...current, transactionOrMessageCreationStatus: 'Simulated', transactionToSimulate: sendEtherWebsiteTransaction, popupVisualisation: newerRun }
		})
		await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast)
		isValidationOverlapped = true
	}
	// After the overlap, the refresh writes the pending confirmation only to persist its approval error.
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (isValidationOverlapped && 'pendingTransactionsAndMessages' in items) isRefreshPersisted = true
	})
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (isRefreshPersisted && requestsStorageKey(keys, 'userAddressBookEntriesV3')) addressBookReadsAfterPersist += 1
		return readStoredItems()
	})

	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, tabId)
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.equal(isRefreshPersisted, true)
	const [refreshedExecution] = await modules.getPendingTransactionsAndMessages()
	if (refreshedExecution?.type !== 'Transaction' || refreshedExecution.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the direct Safe execution with the newer run')
	// The persisted entry carries the newer run, which a re-label could reach.
	assert.equal(refreshedExecution.popupVisualisation.data.simulationId, newerRun.data.simulationId)
	assert.equal(refreshedExecution.popupVisualisation.statusCode, 'success')
	assert.equal(refreshedExecution.approvalStatus.status === 'SignerError' && refreshedExecution.approvalStatus.message.includes('could not be prepared'), true)
	// The refresh simulated no run of its own, so it requests no re-label after persisting, although the change was published during it.
	assert.equal(addressBookReadsAfterPersist, 0)
})

// Stands in for a stored stack or confirmation result, so the shared re-label is checked apart from their storage.
type StoredRunStandIn = { readonly simulationId: number, readonly canBeRelabelled: boolean, readonly recipientName: string | undefined }
const storedRunStandIn: StoredRunStandIn = { simulationId: 1, canBeRelabelled: true, recipientName: undefined }

// Re-labels storedRunStandIn through the shared re-label with the stored stack's simulation. While the re-label looks up names, duringLookups returns the stand-in stored from then on and may abort the re-label. Returns the stand-in stored at the end.
async function relabelStoredRunStandIn(duringLookups: (stored: StoredRunStandIn, abortController: AbortController) => StoredRunStandIn) {
	const { simulationState } = await getStoredStackVisualisation()
	const getRunToRelabel = (stored: StoredRunStandIn): SimulationRunToRelabel<StoredRunStandIn> | undefined => stored.canBeRelabelled
		? { simulationId: stored.simulationId, simulationState, withMetadata: (metadata) => ({ ...stored, recipientName: getRecipientName(metadata.visualizedSimulationState) }) }
		: undefined
	const abortController = new AbortController()
	let stored = storedRunStandIn
	runOnceDuringAddressBookLookup(async () => {
		stored = duringLookups(stored, abortController)
	})
	try {
		await relabelStoredSimulation(simulator.ethereum, simulator.tokenPriceService, {
			stored,
			getRunToRelabel,
			updateStored: async (relabel) => { stored = relabel(stored) ?? stored },
			abortController,
		})
	} catch (error: unknown) {
		if (!isNewBlockAbort(error)) throw error
	}
	browserMock.setStorageGetHandler(undefined)
	return stored
}

test('the shared re-label writes the new metadata only onto the same run while it can still be re-labelled', async () => {
	const relabelOutcomes: readonly { description: string, duringLookups: (stored: StoredRunStandIn, abortController: AbortController) => StoredRunStandIn, expected: StoredRunStandIn }[] = [
		{ description: 'the same run is still stored', duringLookups: (stored) => stored, expected: { ...storedRunStandIn, recipientName: recipientContact.name } },
		{ description: 'a newer run is stored', duringLookups: (stored) => ({ ...stored, simulationId: stored.simulationId + 1 }), expected: { ...storedRunStandIn, simulationId: storedRunStandIn.simulationId + 1 } },
		{ description: 'the same run can no longer be re-labelled', duringLookups: (stored) => ({ ...stored, canBeRelabelled: false }), expected: { ...storedRunStandIn, canBeRelabelled: false } },
		{ description: 'newer work aborts the re-label', duringLookups: (stored, abortController) => { abortController.abort(NEW_BLOCK_ABORT); return stored }, expected: storedRunStandIn },
	]
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	for (const { description, duringLookups, expected } of relabelOutcomes) {
		assert.deepEqual(await relabelStoredRunStandIn(duringLookups), expected, description)
	}
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

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
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogMetadata, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { checksummedAddress, stringifyJSONWithBigInts, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { permit2Message } from './data/eip712Data.js'
import { last } from '../../app/ts/utils/array.js'
import type { UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import { NEW_BLOCK_ABORT, TRANSFER_LOG } from '../../app/ts/utils/constants.js'
import { isNewBlockAbort } from '../../app/ts/utils/errors.js'
import { keccak256, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { activeAddress, addressString, browserMock, hexToBytes, created, createSafeAddressBookEntry, createSafeTx, EIP712Message, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, oldTimestamp, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, simulator, uniqueRequestIdentifier, withSilencedConsole, type RuntimeMessage, type StorageKeys } from './confirmTransactionTestHarness.js'

// Loaded after the harness installs the extension globals that the popup handler dependencies require at import time.
const { addOrModifyAddressBookEntry, changePreSimulationBlockTimeManipulation, refreshPopupConfirmTransactionMetadata, removeAddressBookEntry, requestNewHomeData, setEnsNameForHash } = await import('../../app/ts/background/popupMessageHandlers.js')
const { publishAddressBookChangeAndRelabelSimulations } = await import('../../app/ts/background/addressBookChangePublication.js')
const { getConfirmTransactionAbortController, refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
const { relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmationRelabel.js')
const { relabelStoredSimulation } = await import('../../app/ts/background/simulationRelabel.js')
const { visualizeSimulatorState } = await import('../../app/ts/background/simulationUpdating.js')
const { createWatchAssetResolutionDependencies } = await import('../../app/ts/background/windows/watchAsset.js')
const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')
const { identifyAddressWith, recordIdentifiedAddresses } = await import('../../app/ts/background/metadataUtils.js')

const simulationServicesOwner: SimulationServicesOwner = { getCurrent: () => simulator, reset: () => simulator }

// The displayed confirmation's re-label as an address-book change requests it, without the stack re-label and the notifications.
const relabelDisplayedConfirmation = async () => await relabelDisplayedConfirmationSimulation(fakeRpcNetwork)

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

type SentCall = { readonly to: bigint, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint }

// A website's eth_sendTransaction of the call from the sender, with the pending confirmation that waits for its first simulation.
function createSentTransaction({ to, value, input, gas }: SentCall) {
	const requestParameters: SendTransactionParams = {
		method: 'eth_sendTransaction',
		params: [{ from: sender, to, value, gas, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, input }],
	}
	const transaction: EthereumUnsignedTransaction = { type: '1559', from: sender, chainId: fakeRpcNetwork.chainId, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas, to, value, input, accessList: [] }
	const websiteTransaction: WebsiteCreatedEthereumTransaction = { website, created, originalRequestParameters: requestParameters, transactionIdentifier: 1n, success: true, transaction }
	// The placeholder visualisation is older than any simulation, so the first confirmation simulation replaces it.
	const pendingTransaction: PendingTransactionOrSignableMessage = {
		type: 'Transaction',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters: requestParameters,
		uniqueRequestIdentifier,
		simulationMode: true,
		activeAddress: sender,
		created,
		transactionIdentifier: websiteTransaction.transactionIdentifier,
		website,
		approvalStatus: { status: 'WaitingForUser' },
		transactionOrMessageCreationStatus: 'Simulated',
		transactionToSimulate: websiteTransaction,
		popupVisualisation: {
			statusCode: 'failed',
			data: {
				activeAddress: sender,
				simulationMode: true,
				simulationStartedTimestamp: oldTimestamp,
				uniqueRequestIdentifier,
				transactionToSimulate: websiteTransaction,
				signerName: 'NoSignerDetected',
				error: { code: -1, message: 'Not simulated yet', decodedErrorMessage: 'Not simulated yet' },
				simulationState: { blockNumber: 0n, simulationConductedTimestamp: oldTimestamp },
			},
		},
	}
	return { requestParameters, websiteTransaction, pendingTransaction }
}

type SentTransaction = ReturnType<typeof createSentTransaction>

const sendEther = createSentTransaction({ to: recipient, value: sentEther, input: new Uint8Array(), gas: 21_000n })
const { requestParameters: sendEtherRequestParameters, websiteTransaction: sendEtherWebsiteTransaction } = sendEther

async function storeStackSending({ requestParameters, websiteTransaction }: SentTransaction) {
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				signedTransaction: modules.mockSignTransaction(websiteTransaction.transaction),
				website,
				created,
				originalRequestParameters: requestParameters,
				transactionIdentifier: 2n,
			},
		}],
	}))
}

const storeStackSendingEtherToRecipient = async () => await storeStackSending(sendEther)

async function storeSimulationModeSettings(userAddressBookEntries: readonly AddressBookEntry[]) {
	await modules.browserStorageLocalSet({
		simulationMode: true,
		activeRpcNetwork: fakeRpcNetwork,
		makeCurrentAddressRich: false,
		userAddressBookEntriesV3: userAddressBookEntries,
	})
}

// Simulates the stack and a pending confirmation that both send the transaction.
async function openSimulationModeConfirmation(sentTransaction: SentTransaction, userAddressBookEntries: readonly AddressBookEntry[]) {
	await storeSimulationModeSettings(userAddressBookEntries)
	await storeStackSending(sentTransaction)
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [sentTransaction.pendingTransaction] })
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
}

// Both send ether to the recipient, which is not in the address book unless given.
const openSimulationModeConfirmationSendingEther = async (userAddressBookEntries: readonly AddressBookEntry[] = [senderAddressBookEntry]) => await openSimulationModeConfirmation(sendEther, userAddressBookEntries)

const addRecipientContactWithoutBroadcast = async () => await modules.updateUserAddressBookEntries((entries) => [...entries, recipientContact])

const nameRecipient = async (name: string) => await modules.updateUserAddressBookEntries((entries) => [...entries.filter((entry) => entry.address !== recipient), { ...recipientContact, name }])

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

const getStoredConfirmationRecipientName = async () => getRecipientName((await getStoredPendingTransactionVisualisation()).visualizedSimulationState)

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
async function relabelStoredStack() {
	try {
		await relabelPopupVisualisation(fakeRpcNetwork)
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
	assert.equal(pendingAfter.confirmationRunId, pendingBefore.confirmationRunId)
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

// A contract call: ether sent to the recipient with calldata. The recipient has no code on the fake chain, so its protectors read the recipient's code and warn about calldata sent to an externally owned account; for the confirmation, which runs after the stack's transaction, that code read takes a simulation.
const callRecipientWithCalldata = createSentTransaction({ to: recipient, value: sentEther, input: new Uint8Array([0x12, 0x34, 0x56, 0x78]), gas: 21_000n })
const EOA_CALLDATA_WARNING = 'Transaction to an Externally Owned Account contains calldata.'

const GET_CODE_HELPER_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const getCodeHelperAbi = [{ type: 'function', name: 'at', stateMutability: 'view', inputs: [{ name: 'target', type: 'address' }], outputs: [{ name: 'code', type: 'bytes' }] }] as const
const isGetCodeHelperCall = (call: unknown) => isRecord(call) && (typeof call.to === 'string' || typeof call.to === 'bigint') && BigInt(call.to) === GET_CODE_HELPER_CONTRACT

// The fake chain answers every eth_simulateV1 call with a multicall result, which a simulated code read cannot decode. While run runs, code reads, calls to the get-code helper contract, are answered with no code instead.
async function withSimulatedCodeReadsAnsweredWithNoCode(run: () => Promise<void>) {
	const answerRpcRequest = fakeRequestHandler.jsonRpcRequest
	fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
		const result = await answerRpcRequest(rpcRequest)
		const request = rpcRequest.params?.[0]
		if (rpcRequest.method !== 'eth_simulateV1' || !isRecord(request) || !Array.isArray(request.blockStateCalls) || !Array.isArray(result)) return result
		const blockStateCalls: unknown[] = request.blockStateCalls
		return result.map((block: unknown, blockIndex) => {
			const blockStateCall = blockStateCalls[blockIndex]
			if (!isRecord(block) || !Array.isArray(block.calls) || !isRecord(blockStateCall) || !Array.isArray(blockStateCall.calls)) return block
			const requestedCalls: unknown[] = blockStateCall.calls
			return { ...block, calls: block.calls.map((call: unknown, callIndex) => isGetCodeHelperCall(requestedCalls[callIndex]) && isRecord(call) ? { ...call, returnData: encodeFunctionReturn(getCodeHelperAbi, 'at', ['0x']) } : call) }
		})
	}
	try {
		await run()
	} finally {
		fakeRequestHandler.jsonRpcRequest = answerRpcRequest
	}
}

const openConfirmationCallingRecipientWithCalldata = async () => await withSimulatedCodeReadsAnsweredWithNoCode(async () => await openSimulationModeConfirmation(callRecipientWithCalldata, [senderAddressBookEntry]))

async function getStoredWarningsOfLastTransactions() {
	return {
		stack: getLastVisualizedTransaction((await getStoredStackVisualisation()).stored.visualizedSimulationState).quarantineReasons,
		confirmation: getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState).quarantineReasons,
	}
}

const relabelledNamesWithCalldataWarnings = { names: { stack: recipientContact.name, confirmation: recipientContact.name }, warnings: { stack: [EOA_CALLDATA_WARNING], confirmation: [EOA_CALLDATA_WARNING] } }

const getStoredNamesAndWarnings = async () => ({ names: await getStoredRecipientNames(), warnings: await getStoredWarningsOfLastTransactions() })

test('a re-label of a contract call replays the code reads recorded with the stored runs instead of simulating', async () => {
	await openConfirmationCallingRecipientWithCalldata()
	const before = await getStoredNamesAndWarnings()
	assert.notDeepEqual(before.names, relabelledNamesWithCalldataWarnings.names)
	assert.deepEqual(before.warnings, relabelledNamesWithCalldataWarnings.warnings)
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()

	await publishAddressBookChangeAndWaitForRelabel()

	assert.deepEqual(fakeSafeContract.requestedRpcMethods.filter((method) => method === 'eth_simulateV1'), [])
	// The names follow the address book, while the warning that depends on the recipient's code is kept from the stored runs.
	assert.deepEqual(await getStoredNamesAndWarnings(), relabelledNamesWithCalldataWarnings)
})

test('a re-label of a contract call still updates its names while eth_simulateV1 fails', async () => {
	await openConfirmationCallingRecipientWithCalldata()
	await addRecipientContactWithoutBroadcast()
	fakeSafeContract.failEthSimulate = true

	await publishAddressBookChangeAndWaitForRelabel()

	assert.deepEqual(await getStoredNamesAndWarnings(), relabelledNamesWithCalldataWarnings)
})

// Fails every RPC request in transport while run runs, as when the node is unreachable, and returns the methods that were requested.
async function getRpcMethodsRequestedWhileEveryRequestFails(run: () => Promise<unknown>) {
	const answerRpcRequest = fakeRequestHandler.jsonRpcRequest
	const requestedMethods: string[] = []
	fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
		requestedMethods.push(rpcRequest.method)
		throw new TypeError('Failed to fetch')
	}
	try {
		await run()
	} finally {
		fakeRequestHandler.jsonRpcRequest = answerRpcRequest
	}
	return requestedMethods
}

const removeAddressBookEntryAndWaitForItsRelabel = async (address: bigint, addressBookCategory: 'My Contacts' | 'Other contracts') => await changeAddressBookAndWaitForItsRelabel(async () => await removeAddressBookEntry(simulationServicesOwner, new Map(), {
	method: 'popup_removeAddressBookEntry',
	data: { address, addressBookCategory, chainId: fakeRpcNetwork.chainId },
}))

const hasRecipientNotInAddressBookWarning = (warnings: readonly string[]) => warnings.some((warning) => warning.includes(NOT_IN_ADDRESS_BOOK_WARNING))

// Whether the stored stack and confirmation warn that funds go to an address that is not in the address book.
async function getStoredNotInAddressBookWarnings() {
	const { stack, confirmation } = await getStoredWarningsOfLastTransactions()
	return { stack: hasRecipientNotInAddressBookWarning(stack), confirmation: hasRecipientNotInAddressBookWarning(confirmation) }
}

test('a re-label applies renamed and removed address-book names without any RPC request while every RPC request fails', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, { ...recipientContact, name: 'Older name' }])

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(async () => await changeAddressBookAndWaitForItsRelabel(async () => await nameRecipient('Newest name'))), [])
	assert.deepEqual(await getStoredRecipientNames(), { stack: 'Newest name', confirmation: 'Newest name' })
	assert.deepEqual(await getStoredNotInAddressBookWarnings(), { stack: false, confirmation: false })

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(async () => await removeAddressBookEntryAndWaitForItsRelabel(recipient, 'My Contacts')), [])
	// The removed contact shows its bare address and, as after a simulation, is flagged as not in the address book.
	assert.deepEqual(await getStoredRecipientNames(), { stack: checksummedAddress(recipient), confirmation: checksummedAddress(recipient) })
	assert.deepEqual(await getStoredNotInAddressBookWarnings(), { stack: true, confirmation: true })
})

test('removing a contract that bundled metadata does not know re-labels it to its bare address without identifying it on chain', async () => {
	const contract = 0x111122223333444455556666777788889999aaaan
	await openSimulationModeConfirmation(createSentTransaction({ to: contract, value: 0n, input: new Uint8Array(), gas: 21_000n }), [senderAddressBookEntry, { type: 'contract', address: contract, name: 'Deleted contract name', entrySource: 'User', chainId: fakeRpcNetwork.chainId }])
	assert.deepEqual(await getStoredRecipientNames(), { stack: 'Deleted contract name', confirmation: 'Deleted contract name' })
	// Identifying a contract on chain would read its code and probe its token metadata with eth_simulateV1.
	fakeSafeContract.ownerCode = '0x01'

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(async () => await removeAddressBookEntryAndWaitForItsRelabel(contract, 'Other contracts')), [])

	assert.deepEqual(await getStoredRecipientNames(), { stack: checksummedAddress(contract), confirmation: checksummedAddress(contract) })
})

const removedToken = 0x70c070c070c070c070c070c070c070c070c070c0n
const transferredTokenAmount = 1_500_000n

// Stores the confirmation's run as if its simulation had emitted an ERC20 Transfer of the token from the sender to the recipient, visualised as a simulation run visualises it, which records the entries its address lookups resolve.
async function storeConfirmationRunTransferringToken() {
	const transferLog = { address: removedToken, topics: [BigInt(TRANSFER_LOG), sender, recipient], data: hexToBytes(`0x${ transferredTokenAmount.toString(16).padStart(64, '0') }`), logIndex: 0n, blockHash: null, blockNumber: 123n }
	const storedRun = await getStoredPendingTransactionVisualisation()
	if (storedRun.simulationState.success === false) throw new Error('Expected a successful confirmation simulation')
	const simulationState = { ...storedRun.simulationState, simulatedBlocks: storedRun.simulationState.simulatedBlocks.map((block) => ({
		...block,
		simulatedTransactions: block.simulatedTransactions.map((transaction, index) => index !== block.simulatedTransactions.length - 1 || transaction.ethSimulateV1CallResult.status === 'failure'
			? transaction
			: { ...transaction, ethSimulateV1CallResult: { ...transaction.ethSimulateV1CallResult, logs: [transferLog] } }),
	})) }
	const { simulationState: _visualisedSimulationState, ...visualisedMetadata } = await visualizeSimulatorState(simulationState, simulator.ethereum, simulator.tokenPriceService, undefined)
	await updateStoredConfirmationVisualisation((data) => ({ ...data, ...visualisedMetadata, simulationState }))
}

async function getStoredConfirmationTokenTransferEvent() {
	const tokenEvent = getLastVisualizedTransaction((await getStoredPendingTransactionVisualisation()).visualizedSimulationState).events.find((event) => event.type === 'TokenEvent')
	if (tokenEvent?.type !== 'TokenEvent' || tokenEvent.logInformation.type !== 'ERC20') throw new Error('Expected an ERC20 token transfer')
	return tokenEvent.logInformation
}

async function getStoredConfirmationTokenTransfer() {
	const { token, amount } = await getStoredConfirmationTokenTransferEvent()
	return { token: { type: token.type, name: token.name, symbol: token.symbol, decimals: token.decimals }, amount }
}

const removedTokenEntry: AddressBookEntry = { type: 'ERC20', address: removedToken, name: 'Removed token', symbol: 'RMV', decimals: 6n, entrySource: 'User', chainId: fakeRpcNetwork.chainId }
// The removed token as a re-label shows it once its entry is removed: its bare address, with the kind and decimals the run's amounts need.
const removedTokenAsBareAddress = { type: 'ERC20', name: checksummedAddress(removedToken), symbol: '???', decimals: 6n }

test('a token whose user entry was removed keeps its kind and decimals in a re-label, so its transfer amount still renders under its bare address', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, removedTokenEntry])
	await storeConfirmationRunTransferringToken()
	assert.deepEqual(await getStoredConfirmationTokenTransfer(), { token: { type: 'ERC20', name: 'Removed token', symbol: 'RMV', decimals: 6n }, amount: transferredTokenAmount })
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== removedToken))

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(relabelDisplayedConfirmation), [])

	assert.deepEqual(await getStoredConfirmationTokenTransfer(), { token: removedTokenAsBareAddress, amount: transferredTokenAmount })
	// Only the run's record of what its lookups identified keeps the removed entry, for its kind and decimals; nothing the dialog shows names it.
	const { addressBookEntries, visualizedSimulationState: { identifiedAddressBookEntries: _identifiedAddressBookEntries, ...shownVisualisation } } = await getStoredPendingTransactionVisualisation()
	assert.equal(stringifyJSONWithBigInts([addressBookEntries, shownVisualisation]).includes('Removed token'), false)
})

// The token as identifyAddress caches an on-chain identification in the address book: the name and symbol the contract declares, marked 'OnChain'.
const onChainIdentifiedToken: AddressBookEntry = { ...removedTokenEntry, name: 'Self-declared token name', symbol: 'SELF', entrySource: 'OnChain' }

test('a token the run identified on chain keeps that identification in a re-label after its cached entry is removed, still marked OnChain, without any RPC request', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, onChainIdentifiedToken])
	await storeConfirmationRunTransferringToken()
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== removedToken))

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(relabelDisplayedConfirmation), [])

	// It shows what a new simulation would read from the contract again, and its 'OnChain' source keeps it shown as an untrusted address.
	const { token, amount } = await getStoredConfirmationTokenTransferEvent()
	assert.deepEqual({ name: token.name, symbol: token.symbol, decimals: token.decimals, entrySource: token.entrySource, amount }, { name: 'Self-declared token name', symbol: 'SELF', decimals: 6n, entrySource: 'OnChain', amount: transferredTokenAmount })
})

// The typed-data message as the sender signs it for a website.
function createSignedTypedData(typedData: unknown): SignedMessageTransaction {
	const originalRequestParameters = { method: 'eth_signTypedData_v4' as const, params: [sender, EIP712Message.parse(JSON.stringify(typedData))] as const }
	return {
		website,
		created,
		fakeSignedFor: sender,
		activeAddress: sender,
		originalRequestParameters,
		request: { ...originalRequestParameters, interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier },
		simulationMode: true,
		messageIdentifier: 1n,
	}
}

// A Permit2 approval of the removed token on the fake chain.
function createPermit2OfRemovedToken() {
	const permit2 = JSON.parse(permit2Message)
	return { ...permit2, domain: { ...permit2.domain, chainId: fakeRpcNetwork.chainId.toString() }, message: { ...permit2.message, details: { ...permit2.message.details, token: addressString(removedToken) } } }
}

// Simulates a stack holding only the typed-data message, signed by the sender, while the removed token is still in the address book.
async function storeStackSigningOnly(typedData: unknown) {
	await storeSimulationModeSettings([senderAddressBookEntry, removedTokenEntry])
	const signedMessageTransaction = createSignedTypedData(typedData)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Message', signedMessageTransaction }] }))
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
}

async function getStoredStackSignedMessage() {
	const signedMessage = (await getStoredStackVisualisation()).stored.visualizedSimulationState.visualizedBlocks[0]?.visualizedPersonalSignRequests[0]
	if (signedMessage === undefined) throw new Error('Expected a signed message in the stored stack')
	return signedMessage
}

const describeTokenEntry = (entry: AddressBookEntry) => ({ type: entry.type, name: entry.name, symbol: 'symbol' in entry ? entry.symbol : undefined, decimals: 'decimals' in entry ? entry.decimals : undefined })

// Removes the token's entry and re-labels the stored stack while every RPC request fails, checking that the re-label requested none.
async function removeTokenAndRelabelStoredStack() {
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== removedToken))
	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(relabelStoredStack), [])
}

// The PersonalSign page shows a Permit2 approval amount only for an ERC20 token, and 'Malformed Permit2 request' otherwise.
test('a token whose user entry was removed keeps its kind and decimals in a re-labelled Permit2 message that only the stack signs', async () => {
	await storeStackSigningOnly(createPermit2OfRemovedToken())
	const signedBefore = await getStoredStackSignedMessage()
	if (signedBefore.type !== 'Permit2') throw new Error('Expected a Permit2 message')
	assert.deepEqual(describeTokenEntry(signedBefore.token), { type: 'ERC20', name: 'Removed token', symbol: 'RMV', decimals: 6n })
	// The token is held only by the visualised message, not by the stack's metadata list.
	assert.equal((await getStoredStackVisualisation()).stored.addressBookEntries.some((entry) => entry.address === removedToken), false)

	await removeTokenAndRelabelStoredStack()

	const signedAfter = await getStoredStackSignedMessage()
	if (signedAfter.type !== 'Permit2') throw new Error('Expected a Permit2 message')
	assert.deepEqual(describeTokenEntry(signedAfter.token), removedTokenAsBareAddress)
})

test('a token whose user entry was removed keeps its kind and decimals in an address field of a re-labelled EIP-712 message that only the stack signs', async () => {
	await storeStackSigningOnly({
		types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Order: [{ name: 'token', type: 'address' }] },
		primaryType: 'Order',
		domain: { chainId: fakeRpcNetwork.chainId.toString() },
		message: { token: addressString(removedToken) },
	})
	const getOrderToken = async () => {
		const signedMessage = await getStoredStackSignedMessage()
		if (signedMessage.type !== 'EIP712') throw new Error('Expected an EIP-712 message')
		const tokenField = signedMessage.message.message.token
		if (tokenField?.type !== 'address') throw new Error('Expected an address field')
		return describeTokenEntry(tokenField.value)
	}
	assert.deepEqual(await getOrderToken(), { type: 'ERC20', name: 'Removed token', symbol: 'RMV', decimals: 6n })

	await removeTokenAndRelabelStoredStack()

	assert.deepEqual(await getOrderToken(), removedTokenAsBareAddress)
})

const setOperatorAbi = [{ type: 'function', name: 'setOperator', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }], outputs: [] }] as const

// A website can put any JSON into a typed-data message, including an object shaped like a trusted address-book entry for an address of its choosing.
test('an address-book-entry-shaped object in a signed typed-data message never names an address in a re-label', async () => {
	const registry = 0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0cn
	const plantedAddress = 0xbadbadbadbadbadbadbadbadbadbadbadbadbadbn
	const plantedEntry = { type: 'contract', name: 'Uniswap Router', address: addressString(plantedAddress), entrySource: 'OnChain' }
	await storeSimulationModeSettings([senderAddressBookEntry])
	// The registry call names the planted address only in calldata, which the run cannot parse without the registry's ABI, so the run never resolves that address.
	const callRegistry = createSentTransaction({ to: registry, value: 0n, input: stringToUint8Array(encodeFunctionCall(setOperatorAbi, 'setOperator', [addressString(plantedAddress)])), gas: 60_000n })
	const typedData = {
		types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Listing: [{ name: 'operator', type: 'Operator' }], Operator: [{ name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'address', type: 'string' }, { name: 'entrySource', type: 'string' }] },
		primaryType: 'Listing',
		domain: { chainId: fakeRpcNetwork.chainId.toString() },
		message: { operator: plantedEntry },
	}
	const originalRequestParameters = { method: 'eth_signTypedData_v4' as const, params: [sender, EIP712Message.parse(JSON.stringify(typedData))] as const }
	const signedMessageTransaction: SignedMessageTransaction = { website, created, fakeSignedFor: sender, activeAddress: sender, originalRequestParameters, request: { ...originalRequestParameters, interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }, simulationMode: true, messageIdentifier: 1n }
	await modules.updateInterceptorTransactionStack(() => ({ operations: [
		{ type: 'Transaction', preSimulationTransaction: { signedTransaction: modules.mockSignTransaction(callRegistry.websiteTransaction.transaction), website, created, originalRequestParameters: callRegistry.requestParameters, transactionIdentifier: 2n } },
		{ type: 'Message', signedMessageTransaction },
	] }))
	await withSimulatedCodeReadsAnsweredWithNoCode(async () => { await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true) })
	const getStoredPlantedAddressEntry = async () => (await getStoredStackVisualisation()).stored.addressBookEntries.find((entry) => entry.address === plantedAddress)
	assert.equal(await getStoredPlantedAddressEntry(), undefined)
	// The stored message keeps the planted object as wrapped string fields. A message kind that stored such website values as an entry would put it where entries go, so the planted object is stored there too: only what the run's own lookups resolved may name an address.
	await updatePopupVisualisationWithCallBack(async (stored) => {
		if (stored.visualizedSimulationState.success === false) throw new Error('Expected a successful stack simulation')
		return { ...stored, visualizedSimulationState: { ...stored.visualizedSimulationState, visualizedBlocks: stored.visualizedSimulationState.visualizedBlocks.map((block) => ({
			...block,
			visualizedPersonalSignRequests: block.visualizedPersonalSignRequests.map((signedMessage) => {
				const operator = signedMessage.type === 'EIP712' ? signedMessage.message.message.operator : undefined
				if (signedMessage.type !== 'EIP712' || operator?.type !== 'record') return signedMessage
				const operatorAsEntry = { type: 'address' as const, value: { type: 'contract' as const, name: plantedEntry.name, address: plantedAddress, entrySource: 'OnChain' as const } }
				return { ...signedMessage, message: { ...signedMessage.message, message: { ...signedMessage.message.message, operator: { type: 'record' as const, value: { ...operator.value, address: operatorAsEntry } } } } }
			}),
		})) } }
	})

	// Adding the registry's ABI makes the re-label parse the calldata and name the planted address.
	await modules.updateUserAddressBookEntries((entries) => [...entries, { type: 'contract', address: registry, name: 'Operator registry', entrySource: 'User', chainId: fakeRpcNetwork.chainId, abi: JSON.stringify(setOperatorAbi) }])
	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(relabelStoredStack), [])

	assert.deepEqual(await getStoredPlantedAddressEntry(), { address: plantedAddress, name: checksummedAddress(plantedAddress), type: 'contact', entrySource: 'OnChain', chainId: fakeRpcNetwork.chainId })
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

// A view update sends the dialog its pending confirmations and its stack in two messages; a metadata update after an address-book change sends both in one.
const isPendingConfirmationsUpdate = (message: RuntimeMessage) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions' || message.method === 'popup_update_confirm_transaction_dialog_metadata'
const isStackUpdate = (message: RuntimeMessage) => message.method === 'popup_update_confirm_transaction_dialog' || message.method === 'popup_update_confirm_transaction_dialog_metadata'

function parsePendingConfirmationsUpdate(message: RuntimeMessage | undefined) {
	if (message?.method === 'popup_update_confirm_transaction_dialog_metadata') return UpdateConfirmTransactionDialogMetadata.parse({ method: message.method, data: message.data }).data.pendingTransactionAndSignableMessages
	return UpdateConfirmTransactionDialogPendingTransactions.parse({ method: message?.method, data: message?.data }).data.pendingTransactionAndSignableMessages
}

function parseStackUpdate(message: RuntimeMessage | undefined) {
	if (message?.method === 'popup_update_confirm_transaction_dialog_metadata') return UpdateConfirmTransactionDialogMetadata.parse({ method: message.method, data: message.data }).data.visualizedSimulatorState
	return UpdateConfirmTransactionDialog.parse({ method: message?.method, data: message?.data }).data.visualizedSimulatorState
}

function getLastConfirmationDialogUpdates(sentMessages: readonly RuntimeMessage[]) {
	return {
		pendingTransactions: parsePendingConfirmationsUpdate(sentMessages.findLast(isPendingConfirmationsUpdate)),
		visualizedSimulatorState: parseStackUpdate(sentMessages.findLast(isStackUpdate)),
	}
}

// The displayed entry of every pending-confirmations update sent to the dialog, in the order sent.
function getDisplayedEntriesSentToDialog() {
	return browserMock.sentMessages.filter(isPendingConfirmationsUpdate).map((message) => parsePendingConfirmationsUpdate(message)[0])
}

// The methods of the confirmation dialog updates sent after the first sentMessageCount messages.
const getDialogUpdateMethodsSentSince = (sentMessageCount: number) => browserMock.sentMessages.slice(sentMessageCount).filter((message) => isPendingConfirmationsUpdate(message) || isStackUpdate(message)).map((message) => message.method)

// Answers eth_blockNumber only once released, as when no block is cached and the RPC is slow; requested resolves when it is asked.
function createEthereumStallingBlockNumber() {
	const requested = createDeferred()
	const released = createDeferred()
	const ethereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
			if (rpcRequest.method === 'eth_blockNumber') {
				requested.resolve()
				await released.promise
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum, blockNumberRequested: requested.promise, releaseBlockNumber: released.resolve }
}

test('a confirmation dialog answering the change and re-label notifications ends with the re-labelled confirmation and stack without a simulation', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	// As ConfirmTransaction.tsx does, the open dialog asks for its metadata on both notifications.
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_addressBookEntriesChanged' || message.method === 'popup_simulationsRelabelled') await refreshPopupConfirmTransactionMetadata(simulator.ethereum)
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

// The recipient's name in the last updates the open confirmation dialog and home popup received: the dialog's confirmation and stack, and the home popup's stack.
function getRecipientNamesInLastViewUpdates() {
	const { pendingTransactions, visualizedSimulatorState } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	const homeUpdate = browserMock.sentMessages.findLast((message) => message.method === 'popup_UpdateHomePage')
	if (!isRecord(homeUpdate?.data)) throw new Error('Expected a home page update')
	return {
		dialogConfirmation: getRecipientName(getSimulatedPendingTransaction(pendingTransactions[0]).visualizedSimulationState),
		dialogStack: getRecipientName(visualizedSimulatorState.visualizedSimulationState),
		homeStack: getRecipientName(CompleteVisualizedSimulation.parse(homeUpdate.data.visualizedSimulatorState).visualizedSimulationState),
	}
}

test('an open confirmation dialog and home popup get renamed and removed names without any RPC request, with no cached block and every RPC request failing', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, { ...recipientContact, name: 'Older name' }])
	// A new client has no cached block, so asking it for the current block would request eth_blockNumber.
	const ethereumWithoutCachedBlock = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) { return await fakeRequestHandler.jsonRpcRequest(rpcRequest) },
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	assert.equal(ethereumWithoutCachedBlock.getCachedBlock(), undefined)
	// As ConfirmTransaction.tsx and the home popup do, the open views ask for their data on both notifications: the dialog for its metadata, the home popup, which already shows its first fresh home data, for cached home data.
	const viewUpdates: Promise<void>[] = []
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method !== 'popup_addressBookEntriesChanged' && message.method !== 'popup_simulationsRelabelled') return undefined
		viewUpdates.push(refreshPopupConfirmTransactionMetadata(ethereumWithoutCachedBlock), requestNewHomeData(ethereumWithoutCachedBlock, new Map(), false, true, undefined, 1))
		return undefined
	})
	// Returns the RPC methods requested and the kinds of dialog update sent while the views answer the change.
	const changeAddressBookAndWaitForViewUpdates = async (change: () => Promise<unknown>) => {
		const sentMessageCount = browserMock.sentMessages.length
		const requestedRpcMethods = await getRpcMethodsRequestedWhileEveryRequestFails(async () => {
			await changeAddressBookAndWaitForItsRelabel(change)
			await Promise.all(viewUpdates)
		})
		return { requestedRpcMethods, dialogUpdateKinds: [...new Set(getDialogUpdateMethodsSentSince(sentMessageCount))] }
	}
	// Every dialog update the dialog's metadata requests get is a metadata update, which carries no block number.
	const viewUpdatesWithoutRpc = { requestedRpcMethods: [], dialogUpdateKinds: ['popup_update_confirm_transaction_dialog_metadata'] }

	assert.deepEqual(await changeAddressBookAndWaitForViewUpdates(async () => await nameRecipient('Newest name')), viewUpdatesWithoutRpc)
	assert.deepEqual(getRecipientNamesInLastViewUpdates(), { dialogConfirmation: 'Newest name', dialogStack: 'Newest name', homeStack: 'Newest name' })

	assert.deepEqual(await changeAddressBookAndWaitForViewUpdates(async () => await removeAddressBookEntry(simulationServicesOwner, new Map(), {
		method: 'popup_removeAddressBookEntry',
		data: { address: recipient, addressBookCategory: 'My Contacts', chainId: fakeRpcNetwork.chainId },
	})), viewUpdatesWithoutRpc)
	const bareRecipient = checksummedAddress(recipient)
	assert.deepEqual(getRecipientNamesInLastViewUpdates(), { dialogConfirmation: bareRecipient, dialogStack: bareRecipient, homeStack: bareRecipient })
	browserMock.setRuntimeMessageHandler(undefined)
})

test('a confirmation dialog refresh started before the re-label but sent last still shows the re-labelled names', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	// The refresh answering the address-book change reads the displayed confirmation from before the re-label, and that read returns only once the refresh answering the re-label has been sent.
	const displayedConfirmationReadReleased = createDeferred()
	let holdsNextPendingConfirmationsRead = false
	let isDisplayedConfirmationReadHeld = false
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (!holdsNextPendingConfirmationsRead || !requestsStorageKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		holdsNextPendingConfirmationsRead = false
		isDisplayedConfirmationReadHeld = true
		const storedStateBeforeRelabel = readStoredItems()
		await displayedConfirmationReadReleased.promise
		return storedStateBeforeRelabel
	})
	let refreshAfterAddressBookChange: Promise<void> | undefined
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (message.method === 'popup_addressBookEntriesChanged') {
			holdsNextPendingConfirmationsRead = true
			refreshAfterAddressBookChange = refreshPopupConfirmTransactionMetadata(simulator.ethereum)
		}
		if (message.method === 'popup_simulationsRelabelled') {
			await refreshPopupConfirmTransactionMetadata(simulator.ethereum)
			displayedConfirmationReadReleased.resolve()
		}
		return undefined
	})

	await publishAddressBookChangeAndWaitForRelabel()
	await refreshAfterAddressBookChange
	browserMock.setRuntimeMessageHandler(undefined)
	browserMock.setStorageGetHandler(undefined)
	assert.equal(isDisplayedConfirmationReadHeld, true)

	assert.equal(countSentMessages('popup_update_confirm_transaction_dialog_metadata'), 2)
	const { pendingTransactions, visualizedSimulatorState } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getRecipientName(getSimulatedPendingTransaction(pendingTransactions[0]).visualizedSimulationState), recipientContact.name)
	assert.equal(getRecipientName(visualizedSimulatorState.visualizedSimulationState), recipientContact.name)
})

test('a confirmation dialog refresh whose stored-state read returns after a later refresh read the re-labelled state does not send the older state last', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	clearObservedRpcMethodsAndMessages()
	// The earlier refresh reads the pending confirmations twice: once to see what is displayed, then for the state it sends. That second read takes the stored state at once but returns it only when released.
	let pendingConfirmationReads = 0
	const earlierRefreshReadStoredState = createDeferred()
	const earlierRefreshReadReleased = createDeferred()
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (!requestsStorageKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		pendingConfirmationReads += 1
		if (pendingConfirmationReads !== 2) return readStoredItems()
		const storedStateBeforeRelabel = readStoredItems()
		earlierRefreshReadStoredState.resolve()
		await earlierRefreshReadReleased.promise
		return storedStateBeforeRelabel
	})

	const earlierRefresh = refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	await earlierRefreshReadStoredState.promise
	await relabelDisplayedConfirmation()
	const laterRefresh = refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	// Gives the later refresh time to send its reply before the earlier refresh's read returns.
	await settlesWithin(laterRefresh, 100)
	earlierRefreshReadReleased.resolve()
	await Promise.all([earlierRefresh, laterRefresh])
	browserMock.setStorageGetHandler(undefined)

	assert.equal(await getStoredConfirmationRecipientName(), recipientContact.name)
	assert.equal(countSentMessages('popup_update_confirm_transaction_dialog_metadata'), 2)
	const { pendingTransactions } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getRecipientName(getSimulatedPendingTransaction(pendingTransactions[0]).visualizedSimulationState), recipientContact.name)
})

test('a confirmation view update that read the confirmation before a rename and sends after the re-labelled dialog refresh still sends the new name', async () => {
	await openSimulationModeConfirmationSendingEther([senderAddressBookEntry, { ...recipientContact, name: 'Older name' }])
	clearObservedRpcMethodsAndMessages()
	const viewUpdateServices = createEthereumStallingBlockNumber()
	let pendingConfirmationReads = 0
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (requestsStorageKey(keys, 'pendingTransactionsAndMessages')) pendingConfirmationReads += 1
		return readStoredItems()
	})

	// The view update reads the pending confirmations, then waits for its eth_blockNumber reply while the rename is re-labelled and a dialog refresh sends it.
	const viewUpdate = modules.updateConfirmTransactionView(viewUpdateServices.ethereum, simulator.tokenPriceService)
	await viewUpdateServices.blockNumberRequested
	await waitUntil(() => pendingConfirmationReads >= 1, 'the view update to read the pending confirmations')
	browserMock.setStorageGetHandler(undefined)
	await nameRecipient('Newest name')
	await relabelDisplayedConfirmation()
	await refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	viewUpdateServices.releaseBlockNumber()
	assert.equal(await viewUpdate, true)

	assert.deepEqual(getDisplayedEntriesSentToDialog().map((entry) => getRecipientName(getSimulatedPendingTransaction(entry).visualizedSimulationState)), ['Newest name', 'Newest name'])
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
		// Recorded as when the message arrives, so a dialog refresh names its addresses without the chain.
		const identification = recordIdentifiedAddresses(identifyAddressWith(simulator.ethereum, undefined))
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
			visualizedPersonalSignRequest: await craftPersonalSignPopupMessage(identification.identifyAddress, signedMessageTransaction, fakeRpcNetwork),
			identifiedAddressBookEntries: identification.getIdentifiedEntries(),
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

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum)

	const { pendingTransactions } = getLastConfirmationDialogUpdates(browserMock.sentMessages)
	assert.equal(getSignedAccountName(pendingTransactions[0]), recipientContact.name)
	// Address-book re-labels do not cover signable messages, so only this dialog update carries the new names.
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), storedMessages)
})

test('signable-message dialog refreshes that overlap a rename send their visualisations in the order they made them, so the new name is sent last', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry])
	await nameRecipient('Older name')
	await storeSimulatedPersonalSignMessages([uniqueRequestIdentifier])
	const refreshDialog = async () => await refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	// A first refresh caches the metadata it looks up, which later refreshes read instead.
	await refreshDialog()
	const lookupsPerRefresh = await countAddressBookReads(refreshDialog)
	clearObservedRpcMethodsAndMessages()
	// The earlier refresh's last address-book lookup returns the address book from before the rename. Meanwhile the rename is stored and a later refresh is given time to visualise and send the new name.
	let addressBookReads = 0
	let laterRefresh: Promise<void> | undefined
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (!requestsStorageKey(keys, 'userAddressBookEntriesV3')) return readStoredItems()
		addressBookReads += 1
		if (addressBookReads !== lookupsPerRefresh) return readStoredItems()
		const addressBookBeforeRename = readStoredItems()
		await nameRecipient('Newest name')
		laterRefresh = refreshDialog()
		await settlesWithin(laterRefresh, 100)
		return addressBookBeforeRename
	})

	await refreshDialog()
	await laterRefresh
	browserMock.setStorageGetHandler(undefined)

	assert.deepEqual(getDisplayedEntriesSentToDialog().map(getSignedAccountName), ['Older name', 'Newest name'])
})

test('a signable-message dialog refresh that fails to read the stored stack neither keeps an earlier refresh from sending nor holds back later dialog updates', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry])
	await nameRecipient('Older name')
	await storeSimulatedPersonalSignMessages([uniqueRequestIdentifier])
	clearObservedRpcMethodsAndMessages()
	let isStackReadFailing = false
	browserMock.setStorageGetHandler(async (keys: StorageKeys, readStoredItems) => {
		if (isStackReadFailing && requestsStorageKey(keys, 'popupVisualisation')) {
			isStackReadFailing = false
			throw new Error('Stack storage unavailable')
		}
		return readStoredItems()
	})
	// The first stack read after the earlier refresh has sent is the later refresh's, which fails.
	let hasEarlierRefreshSent = false
	browserMock.setRuntimeMessageHandler(async (message) => {
		if (!hasEarlierRefreshSent && message.method === 'popup_update_confirm_transaction_dialog_metadata') {
			hasEarlierRefreshSent = true
			isStackReadFailing = true
		}
		return undefined
	})

	// The later refresh is requested while the earlier one runs, and waits for it.
	const earlierRefresh = refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	const laterRefresh = refreshPopupConfirmTransactionMetadata(simulator.ethereum)
	await earlierRefresh
	await assert.rejects(laterRefresh, /Stack storage unavailable/)
	browserMock.setRuntimeMessageHandler(undefined)
	browserMock.setStorageGetHandler(undefined)

	assert.equal(await settlesWithin(modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService), 1_000), true)
	assert.equal(await settlesWithin(refreshPopupConfirmTransactionMetadata(simulator.ethereum), 1_000), true)
	// The earlier refresh, the view update and the last refresh each sent the message.
	assert.deepEqual(getDisplayedEntriesSentToDialog().map(getSignedAccountName), ['Older name', 'Older name', 'Older name'])
})

test('a confirmation dialog refresh visualises a displayed signable message whose signer entry was removed without any RPC request', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry])
	await nameRecipient('Older name')
	await storeSimulatedPersonalSignMessages([uniqueRequestIdentifier])
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipient))
	clearObservedRpcMethodsAndMessages()

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(async () => await refreshPopupConfirmTransactionMetadata(simulator.ethereum)), [])

	assert.deepEqual(getDisplayedEntriesSentToDialog().map(getSignedAccountName), [checksummedAddress(recipient)])
})

test('a confirmation dialog refresh keeps the stored visualisation of a pending signable message stored without the entries its visualisation identified', async () => {
	await storeSimulationModeSettings([senderAddressBookEntry, removedTokenEntry])
	const signedMessageTransaction = createSignedTypedData(createPermit2OfRemovedToken())
	// Stored by a version that did not record the entries the message's visualisation identified, so a refresh could not name the token as the token it was once its entry is removed.
	const pendingMessage: PendingTransactionOrSignableMessage = {
		type: 'SignableMessage',
		popupOrTabId: { type: 'popup', id: 1 },
		originalRequestParameters: signedMessageTransaction.originalRequestParameters,
		simulationMode: true,
		uniqueRequestIdentifier,
		signedMessageTransaction,
		created,
		website,
		activeAddress: sender,
		approvalStatus: { status: 'WaitingForUser' },
		transactionOrMessageCreationStatus: 'Simulated',
		visualizedPersonalSignRequest: await craftPersonalSignPopupMessage(identifyAddressWith(simulator.ethereum, undefined), signedMessageTransaction, fakeRpcNetwork),
	}
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingMessage] })
	const [storedMessage] = await modules.getPendingTransactionsAndMessages()
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== removedToken))
	clearObservedRpcMethodsAndMessages()

	assert.deepEqual(await getRpcMethodsRequestedWhileEveryRequestFails(async () => await refreshPopupConfirmTransactionMetadata(simulator.ethereum)), [])

	const [sentMessage] = getDisplayedEntriesSentToDialog()
	assert.deepEqual(getSimulatedSignableMessage(sentMessage).visualizedPersonalSignRequest, getSimulatedSignableMessage(storedMessage).visualizedPersonalSignRequest)
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

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum)
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
	assert.notEqual((await getStoredPendingTransactionVisualisation()).confirmationRunId, pendingBefore.confirmationRunId)
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

// Stored timestamps have second precision, so a re-simulation on the same block within the same second, such as after a gas limit edit, keeps both the block number and the conducted timestamp; only its confirmation run id tells it apart.
test('a confirmation re-simulated on the same block within the same second during a re-label is not replaced by the re-labelled older run', async () => {
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	const relabelledRun = await getStoredPendingTransactionVisualisation()
	const newerRunId = getDefined(relabelledRun.confirmationRunId, 'confirmation run id') + 1
	const editedGasLimit = 30_000n
	runOnceDuringAddressBookLookup(async () => {
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') return undefined
			const transactionToSimulate = { ...current.transactionToSimulate, transaction: { ...current.transactionToSimulate.transaction, gas: editedGasLimit } }
			return { ...current, transactionToSimulate, popupVisualisation: { ...current.popupVisualisation, data: { ...current.popupVisualisation.data, confirmationRunId: newerRunId, transactionToSimulate } } }
		})
	})

	await relabelDisplayedConfirmation()
	browserMock.setStorageGetHandler(undefined)

	const storedRun = await getStoredPendingTransactionVisualisation()
	assert.equal(storedRun.simulationState.blockNumber, relabelledRun.simulationState.blockNumber)
	assert.equal(storedRun.simulationState.simulationConductedTimestamp.getTime(), relabelledRun.simulationState.simulationConductedTimestamp.getTime())
	assert.equal(storedRun.confirmationRunId, newerRunId)
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

	await relabelDisplayedConfirmation()
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

// A transaction stored by a version that did not record the chain reads of its protectors.
function withoutRecordedProtectorChainReads(visualizedSimulationState: VisualizedSimulationState): VisualizedSimulationState {
	if (visualizedSimulationState.success === false) return visualizedSimulationState
	return {
		...visualizedSimulationState,
		visualizedBlocks: visualizedSimulationState.visualizedBlocks.map((block) => ({
			...block,
			simulatedAndVisualizedTransactions: block.simulatedAndVisualizedTransactions.map(({ protectorChainReads: _protectorChainReads, ...transaction }) => transaction),
		})),
	}
}

// A visualisation stored by a version that did not record the entries its address lookups resolved.
const withoutIdentifiedAddressBookEntries = ({ identifiedAddressBookEntries: _identifiedAddressBookEntries, ...visualizedSimulationState }: VisualizedSimulationState): VisualizedSimulationState => visualizedSimulationState

test('confirmations without a confirmation run id or recorded lookups, or simulated on another chain, are not re-labelled', async () => {
	const unprovableConfirmations: readonly { description: string, update: (data: ReturnType<typeof getSimulatedPendingTransaction>) => ReturnType<typeof getSimulatedPendingTransaction> }[] = [
		{ description: 'stored by a version without confirmation run ids', update: ({ confirmationRunId: _confirmationRunId, ...data }) => data },
		{ description: 'stored by a version without recorded protector chain reads, which only a simulation could provide', update: (data) => ({ ...data, visualizedSimulationState: withoutRecordedProtectorChainReads(data.visualizedSimulationState) }) },
		{ description: 'stored by a version without recorded identified address-book entries', update: (data) => ({ ...data, visualizedSimulationState: withoutIdentifiedAddressBookEntries(data.visualizedSimulationState) }) },
		{ description: 'simulated on another chain', update: (data) => ({ ...data, simulationState: { ...data.simulationState, rpcNetwork: { ...data.simulationState.rpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } } }) },
	]
	for (const { description, update } of unprovableConfirmations) {
		await openSimulationModeConfirmationSendingEther()
		const storedConfirmations = await updateStoredConfirmationVisualisation(update)
		await addRecipientContactWithoutBroadcast()

		await relabelDisplayedConfirmation()

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

	const runningRelabel = relabelDisplayedConfirmation()
	await runningRelabelReachedLookup.promise
	const pendingConfirmationReadsBeforeQueuedRelabel = pendingConfirmationReads
	const renamedRecipient = 'Renamed again'
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === recipient ? { ...entry, name: renamedRecipient } : entry))
	const queuedRelabel = relabelDisplayedConfirmation()
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

const countAddressBookReadsOfDisplayedConfirmationRelabel = async () => await countAddressBookReads(async () => await relabelDisplayedConfirmation())

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
			// Only a published change counts; the stack re-label runs without one, as do other confirmation runs' catch-up re-labels.
			{ description: 'the stack is re-labelled without an address-book change', duringLastLookup: relabelStoredStack },
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
	assert.equal((await getStoredPendingTransactionVisualisation()).confirmationRunId, storedRunBefore.confirmationRunId)
	assert.equal(addressBookReadsAfterAbort, 0)
})

test('a confirmation re-simulation that a newer stored run supersedes is not re-labelled for an address-book change published during it', async () => {
	await openSimulationModeConfirmationSendingEther()
	// Stands in for a newer run of the request that was stored first: no run in this test is handed its id, and its later conducted timestamp makes the store keep it.
	const newerRunId = Number.MAX_SAFE_INTEGER

	const addressBookReadsAfterRun = await simulateAndStoreRunningDuringLastLookup(resimulateDisplayedConfirmation, async () => {
		await changeAddressBookAndWaitForItsRelabel(addRecipientContactWithoutBroadcast)
		await updateStoredConfirmationVisualisation((data) => ({ ...data, confirmationRunId: newerRunId, simulationState: { ...data.simulationState, simulationConductedTimestamp: new Date('2100-01-01T00:00:00.000Z') } }))
	})

	assert.equal(addressBookReadsAfterRun, 0)
	assert.equal((await getStoredPendingTransactionVisualisation()).confirmationRunId, newerRunId)
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
	assert.equal(refreshedExecution.popupVisualisation.data.confirmationRunId, newerRun.data.confirmationRunId)
	assert.equal(refreshedExecution.popupVisualisation.statusCode, 'success')
	assert.equal(refreshedExecution.approvalStatus.status === 'SignerError' && refreshedExecution.approvalStatus.message.includes('could not be prepared'), true)
	// The refresh simulated no run of its own, so it requests no re-label after persisting, although the change was published during it.
	assert.equal(addressBookReadsAfterPersist, 0)
})

// Stands in for a stored stack or confirmation result, so the shared re-label is checked apart from their storage.
type StoredRunStandIn = { readonly runId: number, readonly canBeRelabelled: boolean, readonly recipientName: string | undefined }
const storedRunStandIn: StoredRunStandIn = { runId: 1, canBeRelabelled: true, recipientName: undefined }

// Re-labels storedRunStandIn through the shared re-label with the stored stack's simulation. While the re-label looks up names, duringLookups returns the stand-in stored from then on and may abort the re-label. Returns the stand-in stored at the end.
async function relabelStoredRunStandIn(duringLookups: (stored: StoredRunStandIn, abortController: AbortController) => StoredRunStandIn) {
	const { stored: storedStack, simulationState } = await getStoredStackVisualisation()
	const getRunToRelabel = (stored: StoredRunStandIn): SimulationRunToRelabel<StoredRunStandIn> | undefined => stored.canBeRelabelled
		? { runId: stored.runId, simulationState, storedMetadata: storedStack, withMetadata: (metadata) => ({ ...stored, recipientName: getRecipientName(metadata.visualizedSimulationState) }) }
		: undefined
	const abortController = new AbortController()
	let stored = storedRunStandIn
	runOnceDuringAddressBookLookup(async () => {
		stored = duringLookups(stored, abortController)
	})
	try {
		await relabelStoredSimulation(fakeRpcNetwork, {
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
		{ description: 'a newer run is stored', duringLookups: (stored) => ({ ...stored, runId: stored.runId + 1 }), expected: { ...storedRunStandIn, runId: storedRunStandIn.runId + 1 } },
		{ description: 'the same run can no longer be re-labelled', duringLookups: (stored) => ({ ...stored, canBeRelabelled: false }), expected: { ...storedRunStandIn, canBeRelabelled: false } },
		{ description: 'newer work aborts the re-label', duringLookups: (stored, abortController) => { abortController.abort(NEW_BLOCK_ABORT); return stored }, expected: storedRunStandIn },
	]
	await openSimulationModeConfirmationSendingEther()
	await addRecipientContactWithoutBroadcast()
	for (const { description, duringLookups, expected } of relabelOutcomes) {
		assert.deepEqual(await relabelStoredRunStandIn(duringLookups), expected, description)
	}
})

// Fails every eth_simulateV1 request in transport, so a confirmation simulation through it stores no run.
const ethereumFailingSimulations = new modules.EthereumClientService({
	rpcUrl: fakeRpcNetwork.httpsRpc,
	clearCache() { return undefined },
	async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
		if (rpcRequest.method === 'eth_simulateV1') throw new TypeError('Failed to fetch')
		return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
	},
}, async () => undefined, async () => undefined, fakeRpcNetwork)

// A confirmation simulation started during a re-label does not cancel it: the re-label writes only onto the run it re-labelled, and a simulation that ends up storing no run must not cost the stored run its new names.
test('a confirmation simulation that stores no run during a re-label does not stop the displayed confirmation from being re-labelled', async () => {
	const anotherRequest = { ...uniqueRequestIdentifier, requestId: uniqueRequestIdentifier.requestId + 1 }
	const simulationsStoringNoRun: readonly { description: string, simulate: () => Promise<unknown> }[] = [
		// Such as a request appended behind the displayed one, which is simulated as soon as it is added.
		{ description: 'a simulation of another request', simulate: async () => await refreshConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService, sender, true, anotherRequest, sendEtherWebsiteTransaction) },
		{ description: 'a re-simulation of the displayed request whose RPC request fails', simulate: async () => await modules.refreshPopupConfirmTransactionSimulation(ethereumFailingSimulations, simulator.tokenPriceService) },
	]
	for (const { description, simulate } of simulationsStoringNoRun) {
		await openSimulationModeConfirmationSendingEther()
		const storedRunBefore = await getStoredPendingTransactionVisualisation()
		await addRecipientContactWithoutBroadcast()
		runOnceDuringAddressBookLookup(async () => { await simulate() })

		await relabelDisplayedConfirmation()
		browserMock.setStorageGetHandler(undefined)

		const storedRunAfter = await getStoredPendingTransactionVisualisation()
		assert.equal(storedRunAfter.confirmationRunId, storedRunBefore.confirmationRunId, description)
		assert.equal(getRecipientName(storedRunAfter.visualizedSimulationState), recipientContact.name, description)
	}
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

test('a stack simulation stored without recorded protector chain reads or identified address-book entries is not re-labelled', async () => {
	for (const withoutRecord of [withoutRecordedProtectorChainReads, withoutIdentifiedAddressBookEntries]) {
		await openSimulationModeConfirmationSendingEther()
		const visualisationWithoutRecord = await updateStoredStackVisualisation((stored) => ({ ...stored, visualizedSimulationState: withoutRecord(stored.visualizedSimulationState) }))
		await addRecipientContactWithoutBroadcast()
		clearObservedRpcMethodsAndMessages()

		await relabelStoredStack()

		assert.deepEqual(await getPopupVisualisationState(), visualisationWithoutRecord, withoutRecord.name)
		assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), false)
	}
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
	const queuedRelabel = relabelStoredStack()
	const failureRefresh = publishFailedPopupVisualisation()
	runningRelabelLookupReleased.resolve()
	await Promise.all([runningRelabel, queuedRelabel, failureRefresh])
	browserMock.setStorageGetHandler(undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(storedVisualisationWrites.map((write) => CompleteVisualizedSimulation.parse(write).simulationUpdatingState), ['failed'])
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

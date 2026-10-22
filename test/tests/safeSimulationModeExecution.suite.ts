import * as assert from 'assert'
import { test } from 'bun:test'
import type { SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import { activeAddress, addressString, createFeeValidatingSimulator, createSafeAddressBookEntry, createSafeStackTransactionFixture, createWebsitePort, fakeRpcNetwork, isRecord, modules, pendingTransaction, recipientAddress, TOO_LITTLE_ETH_FOR_FEES, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

// createSafeAddressBookEntry configures the Safe at activeAddress.
const SAFE_ADDRESS = activeAddress
const ORDINARY_ACCOUNT = recipientAddress
const OTHER_ACCOUNT = 0x6666666666666666666666666666666666666666n
const SAFE_EXECUTION_SIMULATION_OPTIONS = { requiredChainId: fakeRpcNetwork.chainId, simulateWithZeroBaseFee: true }
const SENDER_PAID_FEES = { gasPayment: 'transaction-sender', simulationOptions: undefined }
const EXECUTOR_PAID_FEES = { gasPayment: 'external-executor', simulationOptions: SAFE_EXECUTION_SIMULATION_OPTIONS }
// A Gnosis Safe proposal or direct execution in signing mode, whose block options come from the Safe flow itself.
const SAFE_SIGNING_FLOW_FEES = { gasPayment: 'external-executor', simulationOptions: undefined }
const SAFE_ADDRESS_BOOK = [createSafeAddressBookEntry({ safeSimulationSignerAddress: recipientAddress, safeVersion: '1.4.1' })]

const createTransferParams = async (fields: Record<string, unknown>) => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{ to: addressString(OTHER_ACCOUNT), value: '0x0', data: '0x', ...fields }],
})

function createWebsiteTabConnections(postedMessages: unknown[]) {
	return new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages),
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
}

// Opens the confirmation in simulation mode with the given active address, which the user selects and the page cannot change.
async function openSimulationModeConfirmation(simulator: ReturnType<typeof createFeeValidatingSimulator>, selectedActiveAddress: bigint, transactionParams: SendTransactionParams, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>, addressBookEntries: readonly SafeEntry[] = SAFE_ADDRESS_BOOK) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => addressBookEntries)
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: selectedActiveAddress })
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		{ kind: 'transaction', parameters: transactionParams },
		true,
		selectedActiveAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)), { type: 'doNotReply' })
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated transaction, got ${ pending?.transactionOrMessageCreationStatus }`)
	return pending
}

test('simulates a transaction from the active Gnosis Safe with executor-paid fees in simulation mode', async () => {
	const simulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const pending = await openSimulationModeConfirmation(simulator, SAFE_ADDRESS, await createTransferParams({ from: addressString(SAFE_ADDRESS) }), websiteTabConnections)

	assert.equal(pending.safeTransaction, undefined, 'simulation mode stacks the transaction instead of proposing it to the Safe')
	assert.deepEqual(pending.feePayment, EXECUTOR_PAID_FEES)
	assert.equal(pending.transactionToSimulate.transaction.from, SAFE_ADDRESS)
	assert.equal(pending.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.deepEqual(pending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	if (pending.popupVisualisation.statusCode !== 'success') throw new Error(`Safe transaction simulation failed: ${ pending.popupVisualisation.data.error.message }`)
	assert.equal(pending.popupVisualisation.data.visualizedSimulationState.success, true)
	assert.equal(pending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.simulateWithZeroBaseFee, true)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	assert.deepEqual(refreshedPending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS, 'refreshing the confirmation keeps the Safe execution fee model')

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	const [stackedOperation] = (await modules.getInterceptorTransactionStack()).operations
	if (stackedOperation?.type !== 'Transaction') throw new Error('Expected the Safe transaction on the simulation stack')
	assert.deepEqual(stackedOperation.preSimulationTransaction.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	assert.equal((await getCurrentSimulationInput()).at(-1)?.simulateWithZeroBaseFee, true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('keeps sender-paid fees and their base fee check when a page names a Gnosis Safe from the address book as the sender', async () => {
	const simulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	const pending = await openSimulationModeConfirmation(simulator, ORDINARY_ACCOUNT, await createTransferParams({ from: addressString(SAFE_ADDRESS) }), createWebsiteTabConnections([]))

	assert.equal(pending.transactionToSimulate.transaction.from, SAFE_ADDRESS, 'simulation mode still simulates the sender the page named')
	assert.equal(pending.transactionToSimulate.simulationOptions, undefined)
	assert.notEqual(pending.transactionToSimulate.transaction.maxFeePerGas, 0n)
	if (pending.popupVisualisation.statusCode !== 'failed') throw new Error('Expected the sender-paid simulation to fail the base fee check')
	assert.match(pending.popupVisualisation.data.error.message, /max fee per gas less than block base fee/u)
})

const getSimulationModeFeePayment = async (selectedActiveAddress: bigint, transactionParams: SendTransactionParams | SendRawTransactionParams) => {
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry()])
	return await (await import('../../app/ts/background/safeTransactionConfirmation.js')).getSimulationModeFeePayment(fakeRpcNetwork.chainId, transactionParams, selectedActiveAddress)
}

const feePaymentCases = [
	{ description: 'the active Safe sends without naming a sender', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({}), expected: EXECUTOR_PAID_FEES },
	{ description: 'the page names the active Safe as the sender', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(SAFE_ADDRESS) }), expected: EXECUTOR_PAID_FEES },
	{ description: 'the page names a configured Safe that is not the active address', selectedActiveAddress: ORDINARY_ACCOUNT, createParams: async () => await createTransferParams({ from: addressString(SAFE_ADDRESS) }), expected: SENDER_PAID_FEES },
	{ description: 'the page names another sender while the Safe is active', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(OTHER_ACCOUNT) }), expected: SENDER_PAID_FEES },
	{ description: 'the active Safe request carries EIP-7702 authorizations', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ authorizationList: [{ chainId: '0x1', address: addressString(OTHER_ACCOUNT), nonce: '0x0' }] }), expected: SENDER_PAID_FEES },
	{ description: 'the request is a raw signed transaction', selectedActiveAddress: SAFE_ADDRESS, createParams: async (): Promise<SendRawTransactionParams> => ({ method: 'eth_sendRawTransaction', params: [new Uint8Array([1])] }), expected: SENDER_PAID_FEES },
]

for (const { description, selectedActiveAddress, createParams, expected } of feePaymentCases) {
	test(`simulation mode fee payment when ${ description }`, async () => {
		assert.deepEqual(await getSimulationModeFeePayment(selectedActiveAddress, await createParams()), expected)
	})
}

test('finds a configured Gnosis Safe only as a Safe entry on its own chain', async () => {
	const { findConfiguredSafeForChain } = await import('../../app/ts/background/signingAddressSelection.js')
	const ordinaryAccountContact = modules.defaultActiveAddresses.find((entry) => entry.address === ORDINARY_ACCOUNT)
	if (ordinaryAccountContact === undefined) throw new Error('Missing the default address book entry of the ordinary account')
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry(), ordinaryAccountContact])

	assert.equal((await findConfiguredSafeForChain(SAFE_ADDRESS, fakeRpcNetwork.chainId))?.address, SAFE_ADDRESS)
	assert.equal(await findConfiguredSafeForChain(SAFE_ADDRESS, fakeRpcNetwork.chainId + 1n), undefined, 'a Safe configured on another chain')
	assert.equal(await findConfiguredSafeForChain(ORDINARY_ACCOUNT, fakeRpcNetwork.chainId), undefined, 'an address book entry that is not a Safe')
})

async function refreshAndGetSimulatedConfirmation(simulator: ReturnType<typeof createFeeValidatingSimulator>) {
	await withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService))
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	return pending
}

const addressBookChangeCases = [
	{ description: 'stops being a configured Gnosis Safe', addressBookWhenOpened: SAFE_ADDRESS_BOOK, addressBookWhenRefreshed: [], expected: EXECUTOR_PAID_FEES },
	{ description: 'becomes a configured Gnosis Safe', addressBookWhenOpened: [], addressBookWhenRefreshed: SAFE_ADDRESS_BOOK, expected: SENDER_PAID_FEES },
]

for (const { description, addressBookWhenOpened, addressBookWhenRefreshed, expected } of addressBookChangeCases) {
	test(`a refresh keeps the fee payment the confirmation opened with when the active address ${ description } meanwhile`, async () => {
		const simulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
		const pending = await openSimulationModeConfirmation(simulator, SAFE_ADDRESS, await createTransferParams({ from: addressString(SAFE_ADDRESS) }), createWebsiteTabConnections([]), addressBookWhenOpened)
		assert.deepEqual(pending.feePayment, expected)

		await modules.updateUserAddressBookEntries(() => addressBookWhenRefreshed)
		const refreshedPending = await refreshAndGetSimulatedConfirmation(simulator)

		assert.notEqual(refreshedPending.popupVisualisation.data.confirmationRunId, pending.popupVisualisation.data.confirmationRunId, 'the refresh stored a new simulation run')
		assert.deepEqual(refreshedPending.feePayment, expected)
		assert.deepEqual(refreshedPending.transactionToSimulate.simulationOptions, expected.simulationOptions)
		assert.equal(refreshedPending.transactionToSimulate.transaction.maxFeePerGas === 0n, expected.gasPayment === 'external-executor')
	})
}

// Rewrites the stored confirmations the way versions that decided the fee payment again on every refresh stored them.
async function forgetStoredFeePayments() {
	const { pendingTransactionsAndMessages } = await browser.storage.local.get('pendingTransactionsAndMessages')
	if (!Array.isArray(pendingTransactionsAndMessages)) throw new Error('Missing stored pending transactions')
	await browser.storage.local.set({ pendingTransactionsAndMessages: pendingTransactionsAndMessages.map((pending: unknown) => {
		if (!isRecord(pending)) return pending
		const { feePayment: _feePayment, ...pendingWithoutFeePayment } = pending
		return pendingWithoutFeePayment
	}) })
}

test('refreshes a simulation-mode confirmation stored without a fee payment with the sender-paid fees older versions used', async () => {
	const simulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openSimulationModeConfirmation(simulator, SAFE_ADDRESS, await createTransferParams({ from: addressString(SAFE_ADDRESS) }), createWebsiteTabConnections([]))
	await forgetStoredFeePayments()
	const [storedPending] = await modules.getPendingTransactionsAndMessages()
	if (storedPending?.type !== 'Transaction') throw new Error('Expected the stored transaction')
	assert.deepEqual(storedPending.feePayment, SENDER_PAID_FEES, 'older versions never simulated a Gnosis Safe transaction with executor-paid fees in simulation mode')

	const refreshedPending = await refreshAndGetSimulatedConfirmation(simulator)

	assert.deepEqual(refreshedPending.feePayment, SENDER_PAID_FEES)
	assert.equal(refreshedPending.transactionToSimulate.simulationOptions, undefined)
	assert.notEqual(refreshedPending.transactionToSimulate.transaction.maxFeePerGas, 0n)
})

const { safeTx, safeTxHash } = createSafeStackTransactionFixture()
const legacySafeFlowCases = [
	{ description: 'a Gnosis Safe proposal', safeFlowFields: { safeTransaction: { safeAddress: SAFE_ADDRESS, safeVersion: '1.4.1', threshold: 1n, safeTxHash, safeTx } } },
	{ description: 'a direct Gnosis Safe execution', safeFlowFields: { safeExecutionOriginalRequestParameters: pendingTransaction.originalRequestParameters } },
]

for (const { description, safeFlowFields } of legacySafeFlowCases) {
	test(`gives ${ description } stored without a fee payment the executor-paid fees older versions refreshed it with`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, simulationMode: false, ...safeFlowFields }] })
		await forgetStoredFeePayments()
		const [storedPending] = await modules.getPendingTransactionsAndMessages()
		if (storedPending?.type !== 'Transaction') throw new Error('Expected the stored transaction')
		assert.deepEqual(storedPending.feePayment, SAFE_SIGNING_FLOW_FEES)
	})
}

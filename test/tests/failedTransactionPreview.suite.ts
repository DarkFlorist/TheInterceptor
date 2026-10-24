import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../../app/ts/types/visualizer-types.js'
import { activeAddress, addressString, browserMock, created, createFeeValidatingSimulator, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, isRecord, modules, recipientAddress, simulator, TOO_LITTLE_ETH_FOR_FEES, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

const USDC_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const TRANSFERRED_USDC = 2_500_000n
const website = { websiteOrigin: 'https://invoices.example', icon: undefined, title: undefined }

type RpcRequest = { method: string, params?: readonly unknown[] }

function createSimulatorWithRpcFailure(getFailure: (rpcRequest: RpcRequest) => Error | undefined) {
	const ethereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: RpcRequest) {
			const failure = getFailure(rpcRequest)
			if (failure !== undefined) throw failure
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum, tokenPriceService: new modules.TokenPriceService(ethereum, 60_000) }
}

const createRpcError = (message: string) => new modules.JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } })

async function useInvoiceAddressBook() {
	await modules.updateUserAddressBookEntries(() => [
		{ type: 'contact', name: 'Invoice Payer', address: activeAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId, useAsActiveAddress: true, askForAddressAccess: false },
		{ type: 'contact', name: 'Supplier', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])
}

async function getUsdcTransferParams() {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	return SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(USDC_ADDRESS),
			value: '0x0',
			data: encodeFunctionCall(Erc20ABI, 'transfer', [addressString(recipientAddress), TRANSFERRED_USDC]),
		}],
	})
}

async function createFormedUsdcTransfer(transactionIdentifier: bigint): Promise<WebsiteCreatedEthereumTransaction> {
	const transactionParams = await getUsdcTransferParams()
	return {
		website,
		created,
		originalRequestParameters: transactionParams,
		transactionIdentifier,
		success: true,
		transaction: {
			type: '1559',
			from: activeAddress,
			chainId: fakeRpcNetwork.chainId,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 60_000n,
			to: USDC_ADDRESS,
			value: 0n,
			input: transactionParams.params[0].data ?? new Uint8Array(),
			accessList: [],
		},
	}
}

async function createUnformedUsdcTransfer(transactionIdentifier: bigint): Promise<WebsiteCreatedEthereumTransactionOrFailed> {
	return {
		website,
		created,
		originalRequestParameters: await getUsdcTransferParams(),
		transactionIdentifier,
		success: false,
		error: { code: -32000, message: 'execution reverted' },
	}
}

type SupersededLookupOutcome = 'rejects' | 'resolves'
const SUPERSEDED_LOOKUP_OUTCOMES: readonly SupersededLookupOutcome[] = ['rejects', 'resolves']

// Runs a newer refresh the first time the address is looked up on chain, while the superseded refresh resolves its metadata. Afterwards the lookup either rejects the way the RPC request handler rejects an aborted request, or resolves the way a cached lookup does.
function supersedeDuringAddressLookup(ethereum: InstanceType<typeof modules.EthereumClientService>, lookedUpAddress: bigint, supersededLookupOutcome: SupersededLookupOutcome, runNewerRefresh: () => Promise<void>) {
	let newerRefreshStarted = false
	return new Proxy(ethereum, {
		get(target, property, receiver) {
			if (property !== 'getCode') return Reflect.get(target, property, receiver)
			return async (...getCodeArguments: Parameters<typeof target.getCode>) => {
				if (getCodeArguments[0] === lookedUpAddress && !newerRefreshStarted) {
					newerRefreshStarted = true
					await runNewerRefresh()
					if (supersededLookupOutcome === 'rejects') throw new Error(NEW_BLOCK_ABORT)
				}
				return await target.getCode(...getCodeArguments)
			}
		},
	})
}

// Opens the confirmation dialog the way a website's eth_sendTransaction does, and checks that the website's request is left waiting for the user instead of being rejected.
async function openTransactionConfirmation(confirmationSimulator: ReturnType<typeof createFeeValidatingSimulator>, transactionParams: SendTransactionParams) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: activeAddress })
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, []),
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: website.websiteOrigin,
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		confirmationSimulator.ethereum,
		confirmationSimulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		{ kind: 'transaction', parameters: transactionParams },
		true,
		activeAddress,
		website,
		websiteTabConnections,
	)), { type: 'doNotReply' })
}

const openUsdcTransferConfirmation = async (confirmationSimulator: ReturnType<typeof createFeeValidatingSimulator>) => await openTransactionConfirmation(confirmationSimulator, await getUsdcTransferParams())

async function getPendingFailedTransactionVisualisation() {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || !('popupVisualisation' in pending)) throw new Error('Missing simulated pending transaction')
	return pending.popupVisualisation
}

function assertUsdcTransferPreview(failedTransactionPreview: Awaited<ReturnType<typeof getPendingFailedTransactionVisualisation>>['data']['failedTransactionPreview'], expectedUsdcName = 'USDC') {
	if (failedTransactionPreview === undefined) throw new Error('Missing failed transaction preview')
	const findEntry = (address: bigint) => failedTransactionPreview.addressBookEntries.find((entry) => entry.address === address)
	assert.equal(findEntry(activeAddress)?.name, 'Invoice Payer')
	assert.equal(findEntry(USDC_ADDRESS)?.name, expectedUsdcName)
	assert.equal(findEntry(USDC_ADDRESS)?.type, 'ERC20')
	assert.equal(findEntry(recipientAddress)?.name, 'Supplier')
	const { parsedInputData } = failedTransactionPreview
	if (parsedInputData.type !== 'Parsed') throw new Error('Expected the USDC transfer calldata to be parsed with the token ABI')
	assert.equal(parsedInputData.name, 'transfer')
	assert.deepEqual(parsedInputData.args.map((argument) => argument.typeValue), [
		{ type: 'address', value: recipientAddress },
		{ type: 'unsignedInteger', value: TRANSFERRED_USDC },
	])
}

test('resolves address-book names and parses calldata when the confirmation simulation fails', async () => {
	await useInvoiceAddressBook()
	await openUsdcTransferConfirmation(createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES))

	const popupVisualisation = await getPendingFailedTransactionVisualisation()
	if (popupVisualisation.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	assert.match(popupVisualisation.data.error.message, /max fee per gas less than block base fee/u)
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview)
})

test('resolves address-book names and parses calldata when the transaction could not be formed', async () => {
	await useInvoiceAddressBook()
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		simulator.ethereum,
		simulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		await createUnformedUsdcTransfer(7n),
	)

	assert.equal(popupVisualisation?.statusCode, 'success')
	assert.equal(popupVisualisation?.data.transactionToSimulate.success, false)
	assertUsdcTransferPreview(popupVisualisation?.data.failedTransactionPreview)
})

test('refreshes the failed transaction preview when the address book changes', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	await modules.updateUserAddressBookEntries((entries) => [
		...entries,
		{ type: 'ERC20', name: 'Circle USD', symbol: 'USDC', decimals: 6n, address: USDC_ADDRESS, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])

	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined))

	const popupVisualisation = await getPendingFailedTransactionVisualisation()
	assert.equal(popupVisualisation.statusCode, 'failed')
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview, 'Circle USD')
})

// Rewrites the stored confirmations the way versions without confirmation run ids stored them.
async function forgetStoredConfirmationRunIds() {
	const { pendingTransactionsAndMessages } = await browser.storage.local.get('pendingTransactionsAndMessages')
	if (!Array.isArray(pendingTransactionsAndMessages)) throw new Error('Missing stored pending transactions')
	await browser.storage.local.set({ pendingTransactionsAndMessages: pendingTransactionsAndMessages.map((pending: unknown) => {
		if (!isRecord(pending) || !isRecord(pending.popupVisualisation) || !isRecord(pending.popupVisualisation.data)) return pending
		const { confirmationRunId: _confirmationRunId, ...dataWithoutConfirmationRunId } = pending.popupVisualisation.data
		return { ...pending, popupVisualisation: { ...pending.popupVisualisation, data: dataWithoutConfirmationRunId } }
	}) })
}

test('refreshes the metadata of a confirmation stored without a confirmation run id as older than any run', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	const confirmationRunId = (await getPendingFailedTransactionVisualisation()).data.confirmationRunId
	await forgetStoredConfirmationRunIds()
	assert.equal((await getPendingFailedTransactionVisualisation()).data.confirmationRunId < confirmationRunId, true, 'a confirmation stored without a confirmation run id parses as older than any run')
	await modules.updateUserAddressBookEntries((entries) => [
		...entries,
		{ type: 'ERC20', name: 'Circle USD', symbol: 'USDC', decimals: 6n, address: USDC_ADDRESS, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])

	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined))

	assertUsdcTransferPreview((await getPendingFailedTransactionVisualisation()).data.failedTransactionPreview, 'Circle USD')
})

test('keeps a newer simulation run stored during the failure preview metadata refresh even when both runs share a timestamp', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	let initialVisualisation: Awaited<ReturnType<typeof getPendingFailedTransactionVisualisation>> | undefined
	let newerVisualisation: Awaited<ReturnType<typeof getPendingFailedTransactionVisualisation>> | undefined
	// The frozen clock gives the initial and the newer simulation run the same stored timestamp, as two runs within one second get, so only the run identity tells them apart.
	setSystemTime(new Date())
	try {
		await openUsdcTransferConfirmation(confirmationSimulator)
		initialVisualisation = await getPendingFailedTransactionVisualisation()
		// Forgetting the supplier makes the metadata refresh look it up on chain, which is when the newer simulation run is stored.
		await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
		const ethereumRunningNewerSimulationDuringLookup = supersedeDuringAddressLookup(confirmationSimulator.ethereum, recipientAddress, 'resolves', async () => {
			// Saving the supplier again gives the newer run a preview that the metadata refresh, already past the address book, cannot produce.
			await useInvoiceAddressBook()
			await refreshPopupConfirmTransactionSimulation(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService)
			newerVisualisation = await getPendingFailedTransactionVisualisation()
		})

		await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(ethereumRunningNewerSimulationDuringLookup, confirmationSimulator.tokenPriceService, undefined))
	} finally {
		setSystemTime()
	}

	if (initialVisualisation === undefined || newerVisualisation === undefined) throw new Error('The newer simulation run was not stored during the metadata lookup')
	assert.equal(newerVisualisation.data.simulationState.simulationConductedTimestamp.getTime(), initialVisualisation.data.simulationState.simulationConductedTimestamp.getTime())
	assertUsdcTransferPreview(newerVisualisation.data.failedTransactionPreview)
	assert.deepEqual(await getPendingFailedTransactionVisualisation(), newerVisualisation, 'the metadata of the initial run replaced the newer run')
})

test('keeps a newer simulation run that got the run id of the run the metadata refresh read, as after a background restart', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	await openUsdcTransferConfirmation(confirmationSimulator)
	const initialVisualisation = await getPendingFailedTransactionVisualisation()
	if (initialVisualisation.statusCode !== 'failed') throw new Error('Expected the initial run to fail')
	// After a restart, a new run can get the id of a run stored before it, if the earlier session's ids ran ahead of the clock or the clock moved back.
	const newerVisualisationWithSameRunId = { ...initialVisualisation, data: { ...initialVisualisation.data, error: { ...initialVisualisation.data.error, message: 'the newer run', decodedErrorMessage: 'the newer run' } } }
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
	const ethereumStoringNewerRunDuringLookup = supersedeDuringAddressLookup(confirmationSimulator.ethereum, recipientAddress, 'resolves', async () => {
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => pending.type === 'Transaction' && 'popupVisualisation' in pending ? { ...pending, popupVisualisation: newerVisualisationWithSameRunId } : pending)
	})

	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(ethereumStoringNewerRunDuringLookup, confirmationSimulator.tokenPriceService, undefined))

	const storedVisualisation = await getPendingFailedTransactionVisualisation()
	assert.equal(storedVisualisation.data.confirmationRunId, initialVisualisation.data.confirmationRunId)
	assert.deepEqual(storedVisualisation, newerVisualisationWithSameRunId, 'the metadata refresh wrote the run it read over the newer run with the same id')
})

test('neither names nor probes the EIP-7702 delegation target or the contract a creation would deploy, which the failure view does not show', async () => {
	await useInvoiceAddressBook()
	const unknownDelegationTarget = 0x7777777777777777777777777777777777777777n
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { getDeployedContractAddress } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	const wouldBeDeployedContract = getDeployedContractAddress(activeAddress, 0n)
	const requestWithAuthorization = {
		from: addressString(activeAddress),
		to: addressString(USDC_ADDRESS),
		value: '0x0',
		data: encodeFunctionCall(Erc20ABI, 'transfer', [addressString(recipientAddress), TRANSFERRED_USDC]),
		authorizationList: [{ chainId: '0x1', address: addressString(unknownDelegationTarget), nonce: '0x0' }],
	}
	const contractCreationWithNonce = { from: addressString(activeAddress), value: '0x0', data: '0x6000', nonce: '0x0' }
	const { getFailedTransactionPreview } = await import('../../app/ts/background/simulationUpdating.js')
	for (const request of [requestWithAuthorization, contractCreationWithNonce]) {
		const preview = await getFailedTransactionPreview(simulator.ethereum, undefined, {
			website,
			created,
			originalRequestParameters: SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [request] }),
			transactionIdentifier: 1n,
			success: false,
			error: { code: -32000, message: 'gas estimation failed' },
		})
		assert.equal(preview.addressBookEntries.some((entry) => entry.address === activeAddress), true, 'the failure view names the sender it shows')
		assert.equal(preview.addressBookEntries.some((entry) => entry.address === unknownDelegationTarget || entry.address === wouldBeDeployedContract), false)
	}
	const storedAddresses = (await modules.getUserAddressBookEntries()).map((entry) => entry.address)
	assert.equal(storedAddresses.includes(unknownDelegationTarget) || storedAddresses.includes(wouldBeDeployedContract), false, 'no identification of an address the view does not show was kept in the address book')
})

test('keeps and shows the names of a newer metadata refresh when an older refresh of the same failed confirmation finishes last', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	// Forgetting the supplier makes the older refresh look it up on chain after reading the payer's name, which is when the payer is renamed and the newer refresh runs.
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const getStoredPayerName = async () => (await getPendingFailedTransactionVisualisation()).data.failedTransactionPreview?.addressBookEntries.find((entry) => entry.address === activeAddress)?.name
	const isDialogUpdate = (message: unknown) => isRecord(message) && message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'
	let payerNameAfterNewerRefresh: string | undefined
	let messagesSentBeforeOlderRefreshResumes = 0
	const ethereumRefreshingAgainDuringLookup = supersedeDuringAddressLookup(confirmationSimulator.ethereum, recipientAddress, 'resolves', async () => {
		await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === activeAddress ? { ...entry, name: 'Renamed Payer' } : entry))
		await refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined)
		payerNameAfterNewerRefresh = await getStoredPayerName()
		messagesSentBeforeOlderRefreshResumes = browserMock.sentMessages.length
	})
	browserMock.sentMessages.length = 0

	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(ethereumRefreshingAgainDuringLookup, confirmationSimulator.tokenPriceService, undefined))

	assert.equal(payerNameAfterNewerRefresh, 'Renamed Payer', 'the newer refresh runs during the older refresh and stores the new name')
	assert.equal(browserMock.sentMessages.slice(0, messagesSentBeforeOlderRefreshResumes).some(isDialogUpdate), true, 'the newer refresh updates the dialog')
	assert.equal(await getStoredPayerName(), 'Renamed Payer', 'the older refresh replaced the newer names')
	assert.equal(browserMock.sentMessages.slice(messagesSentBeforeOlderRefreshResumes).some(isDialogUpdate), false, 'the older refresh sent the dialog an update after the newer one')
})

test('stores the names of a newer metadata refresh that read the confirmation before an older refresh\'s write landed', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const getStoredPayerName = async () => (await getPendingFailedTransactionVisualisation()).data.failedTransactionPreview?.addressBookEntries.find((entry) => entry.address === activeAddress)?.name
	const renamePayer = async (name: string) => await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === activeAddress ? { ...entry, name } : entry))
	// Holds the older refresh's write of the pending transactions until the newer refresh has read them.
	let releaseOlderWrite: (() => void) | undefined
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (releaseOlderWrite === undefined && 'pendingTransactionsAndMessages' in items) {
			await new Promise<void>((resolve) => { releaseOlderWrite = resolve })
		}
		writeStoredItems()
	})
	await renamePayer('First name')
	const olderRefresh = refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined)
	while (releaseOlderWrite === undefined) await new Promise((resolve) => setTimeout(resolve, 1))
	await renamePayer('Second name')
	const newerRefresh = refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined)
	await new Promise((resolve) => setTimeout(resolve, 10))
	releaseOlderWrite()
	await withSilencedConsole(async () => await Promise.all([olderRefresh, newerRefresh]))
	browserMock.setStorageSetHandler(undefined)

	assert.equal(await getStoredPayerName(), 'Second name', 'the older refresh\'s names, stored after the newer refresh read the confirmation, made the newer refresh drop its own')
})

test('resolves address-book names and parses calldata when the confirmation simulation throws', async () => {
	await useInvoiceAddressBook()
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_getBalance' ? createRpcError('balance lookup unavailable') : undefined).ethereum,
		simulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		await createFormedUsdcTransfer(9n),
	)

	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	assert.equal(popupVisualisation.data.error.message, 'balance lookup unavailable')
	assert.equal(popupVisualisation.data.simulationState.blockNumber, 0n, 'the simulation threw instead of returning a failed simulation state')
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview)
})

test('collects the failure view addresses with the simulation view rules, leaving out the contract a creation would deploy', async () => {
	await useInvoiceAddressBook()
	const { getFailedTransactionPreview } = await import('../../app/ts/background/simulationUpdating.js')
	const { getAddressesToIdentifyForVisualiserFromTransactions } = await import('../../app/ts/background/metadataUtils.js')
	const { getDeployedContractAddress } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	const transfer = await createFormedUsdcTransfer(15n)
	const contractCreation = { ...transfer, transaction: { ...transfer.transaction, to: null } }
	const deployedContract = getDeployedContractAddress(activeAddress, 0n)
	for (const transactionToSimulate of [transfer, contractCreation]) {
		const failedTransactionPreview = await getFailedTransactionPreview(simulator.ethereum, undefined, transactionToSimulate)
		const simulationViewAddresses = getAddressesToIdentifyForVisualiserFromTransactions([], [failedTransactionPreview.parsedInputData], [{
			stateOverrides: {},
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
			transactions: [{
				signedTransaction: modules.mockSignTransaction(transactionToSimulate.transaction),
				website,
				created,
				originalRequestParameters: transactionToSimulate.originalRequestParameters,
				transactionIdentifier: transactionToSimulate.transactionIdentifier,
			}],
		}])
		const failureViewAddresses = new Set(failedTransactionPreview.addressBookEntries.map((entry) => entry.address))
		assert.deepEqual(failureViewAddresses, new Set(simulationViewAddresses.filter((address) => address !== deployedContract)))
		assert.equal(failureViewAddresses.has(ETHEREUM_LOGS_LOGGER_ADDRESS), true)
		assert.equal(simulationViewAddresses.includes(deployedContract), transactionToSimulate === contractCreation, 'the simulation view of the creation names the contract it deploys')
	}
})

const failedPreviewLookups = [
	{ description: 'an RPC failure', createLookupError: async () => (await import('../../app/ts/utils/errors.js')).createInterceptorInternalError('Failed to fetch', 'fetch_transport_failed', 'failedToFetch'), isDefect: false },
	{ description: 'a defect', createLookupError: async () => new Error('address probe decoder defect'), isDefect: true },
]

for (const { description, createLookupError, isDefect } of failedPreviewLookups) {
	test(`stores and shows the transaction's own failure without a preview when the preview lookup hits ${ description }`, async () => {
		const unknownContractAddress = 0x4444444444444444444444444444444444444444n
		const lookupError = await createLookupError()
		const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
		const { getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await import('../../app/ts/background/storageVariables.js')
		let failedLookups = 0
		// Simulation mode estimates gas with eth_simulateV1, so failing it leaves the transaction unformed, and only its failure preview looks up the unknown contract.
		const confirmationSimulator = createSimulatorWithRpcFailure((rpcRequest) => {
			if (rpcRequest.method === 'eth_simulateV1') return createRpcError('execution reverted')
			if (rpcRequest.method !== 'eth_getCode' || rpcRequest.params?.[0] !== unknownContractAddress) return undefined
			failedLookups += 1
			return lookupError
		})

		await openTransactionConfirmation(confirmationSimulator, SendTransactionParams.parse({
			method: 'eth_sendTransaction',
			params: [{ from: addressString(activeAddress), to: addressString(unknownContractAddress), value: '0x0', data: '0x' }],
		}))

		assert.equal(failedLookups > 0, true, 'the failure preview looked up the unknown contract')
		const popupVisualisation = await getPendingFailedTransactionVisualisation()
		const { transactionToSimulate } = popupVisualisation.data
		if (transactionToSimulate.success) throw new Error('Expected the transaction to stay unformed')
		assert.equal(transactionToSimulate.error.message, 'execution reverted')
		assert.equal(popupVisualisation.data.failedTransactionPreview, undefined)
		const previewFailureReports = (await getInterceptorErrorDiagnostics()).filter((diagnostic) => diagnostic.code === 'failed_transaction_preview_failed')
		assert.equal(previewFailureReports.length, isDefect ? 1 : 0, 'a defect is reported once and an RPC failure is not reported')
		assert.equal((await getLatestUnexpectedError())?.data.message, isDefect ? 'address probe decoder defect' : undefined)
	})
}

for (const { description, createLookupError, isDefect } of failedPreviewLookups) {
	test(`keeps the stored failure and still updates the dialog when the metadata refresh's preview lookup hits ${ description }`, async () => {
		await useInvoiceAddressBook()
		const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
		await openUsdcTransferConfirmation(confirmationSimulator)
		const storedFailure = await getPendingFailedTransactionVisualisation()
		// Forgetting the supplier makes the metadata refresh look it up on chain, where the lookup fails.
		await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
		const lookupError = await createLookupError()
		const ethereumFailingRecipientLookup = new Proxy(confirmationSimulator.ethereum, {
			get(target, property, receiver) {
				if (property !== 'getCode') return Reflect.get(target, property, receiver)
				return async (...getCodeArguments: Parameters<typeof target.getCode>) => {
					if (getCodeArguments[0] === recipientAddress) throw lookupError
					return await target.getCode(...getCodeArguments)
				}
			},
		})
		const { getInterceptorErrorDiagnostics } = await import('../../app/ts/background/storageVariables.js')
		const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
		browserMock.sentMessages.length = 0

		await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(ethereumFailingRecipientLookup, confirmationSimulator.tokenPriceService, undefined))

		assert.deepEqual(await getPendingFailedTransactionVisualisation(), storedFailure)
		assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), true, 'the rest of the dialog metadata is still refreshed')
		const previewFailureReports = (await getInterceptorErrorDiagnostics()).filter((diagnostic) => diagnostic.code === 'failed_transaction_preview_failed')
		assert.equal(previewFailureReports.length, isDefect ? 1 : 0, 'a defect is reported once and an RPC failure is not reported')
	})
}

test('keeps the newer stored simulation when a refresh is superseded during its failure preview lookup', async () => {
	await useInvoiceAddressBook()
	// Simulation mode estimates gas with eth_simulateV1, so failing it leaves the transaction unformed and the failure preview resolves the transfer recipient.
	const createUnformableTransferSimulator = () => createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_simulateV1' ? createRpcError('execution reverted') : undefined)
	await openUsdcTransferConfirmation(createUnformableTransferSimulator())
	const initialSimulationConductedTimestamp = (await getPendingFailedTransactionVisualisation()).data.simulationState.simulationConductedTimestamp
	// Forgetting the supplier makes the failure preview look it up on chain, which is when the newer refresh runs.
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const newerSimulator = createUnformableTransferSimulator()
	const supersededSimulator = createUnformableTransferSimulator()
	let newerVisualisation: Awaited<ReturnType<typeof getPendingFailedTransactionVisualisation>> | undefined
	const ethereumSupersededDuringPreview = supersedeDuringAddressLookup(supersededSimulator.ethereum, recipientAddress, 'rejects', async () => {
		// Saving the supplier again gives the newer refresh a preview that the superseded refresh, already past the address book, cannot produce.
		await useInvoiceAddressBook()
		await refreshPopupConfirmTransactionSimulation(newerSimulator.ethereum, newerSimulator.tokenPriceService)
		newerVisualisation = await getPendingFailedTransactionVisualisation()
	})

	// Both refreshes simulate at one frozen time after the initial simulation, so the stored-result timestamp guard cannot reject the superseded failure and only its cancellation keeps it out. Bun's clock is frozen instead of replacing Date, which would fail the Date checks on fixtures created before the swap.
	const refreshTime = new Date(initialSimulationConductedTimestamp.getTime() + 60_000)
	setSystemTime(refreshTime)
	try {
		await withSilencedConsole(async () => await refreshPopupConfirmTransactionSimulation(ethereumSupersededDuringPreview, supersededSimulator.tokenPriceService))
	} finally {
		setSystemTime()
	}

	if (newerVisualisation === undefined) throw new Error('The newer refresh did not run during the failure preview lookup')
	assert.equal(newerVisualisation.data.simulationState.simulationConductedTimestamp.getTime(), refreshTime.getTime(), 'the newer refresh replaced the initial stored simulation')
	assert.equal(newerVisualisation.data.transactionToSimulate.success, false)
	assertUsdcTransferPreview(newerVisualisation.data.failedTransactionPreview)
	assert.deepEqual(await getPendingFailedTransactionVisualisation(), newerVisualisation, 'the superseded refresh replaced the newer stored simulation')
})

const refreshUsdcTransferSimulation = async (ethereum: InstanceType<typeof modules.EthereumClientService>, transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed) => {
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	return await refreshConfirmTransactionSimulation(ethereum, simulator.tokenPriceService, activeAddress, true, uniqueRequestIdentifier, transactionToSimulate)
}

// Each scenario reaches a different failure branch with the transfer recipient missing from the empty address book. The recipient is first looked up on chain by the failure preview, except after a failed simulation, whose own visualisation looks it up and saves it, so its failure preview then finds it locally without noticing an abort.
const supersededFailurePreviewScenarios = [
	{
		scenario: 'the confirmation simulation fails',
		createSimulator: () => createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES),
		refresh: async (ethereum: InstanceType<typeof modules.EthereumClientService>) => await refreshUsdcTransferSimulation(ethereum, await createFormedUsdcTransfer(14n)),
	},
	{
		scenario: 'the transaction could not be formed',
		createSimulator: () => simulator,
		refresh: async (ethereum: InstanceType<typeof modules.EthereumClientService>) => await refreshUsdcTransferSimulation(ethereum, await createUnformedUsdcTransfer(12n)),
	},
	{
		scenario: 'the confirmation simulation throws',
		createSimulator: () => createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_getBalance' ? createRpcError('balance lookup unavailable') : undefined),
		refresh: async (ethereum: InstanceType<typeof modules.EthereumClientService>) => await refreshUsdcTransferSimulation(ethereum, await createFormedUsdcTransfer(13n)),
	},
]

for (const { scenario, createSimulator, refresh } of supersededFailurePreviewScenarios) {
	for (const supersededLookupOutcome of SUPERSEDED_LOOKUP_OUTCOMES) {
		test(`returns no result from a refresh superseded during its recipient lookup when ${ scenario } and the lookup ${ supersededLookupOutcome }`, async () => {
			await modules.updateUserAddressBookEntries(() => [])
			const failingSimulator = createSimulator()
			let newerRefreshResult: Awaited<ReturnType<typeof refresh>>
			const ethereumSupersededDuringLookup = supersedeDuringAddressLookup(failingSimulator.ethereum, recipientAddress, supersededLookupOutcome, async () => {
				newerRefreshResult = await refresh(failingSimulator.ethereum)
			})

			const supersededRefreshResult = await withSilencedConsole(async () => await refresh(ethereumSupersededDuringLookup))

			assert.notEqual(newerRefreshResult, undefined, 'the newer refresh runs during the recipient lookup and completes')
			assert.equal(supersededRefreshResult, undefined)
		})
	}
}

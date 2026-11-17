import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import * as assert from 'assert'
import { setSystemTime, test as testWithDefaultNetwork } from 'bun:test'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../../app/ts/types/visualizer-types.js'
import { activeAddress, addressString, browserMock, created, createFeeValidatingSimulator, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, isRecord, modules, recipientAddress, TOO_LITTLE_ETH_FOR_FEES, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

// These previews use their own mainnet clients; mutating the shared local-chain fixture can leak into Safe fixtures evaluated while these tests run.
const previewRpcNetwork = { ...fakeRpcNetwork, chainId: 1n }
const previewEthereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, previewRpcNetwork)
const simulator = { ethereum: previewEthereum, tokenPriceService: new modules.TokenPriceService(previewEthereum, 60_000) }
const test = (name: string, run: () => Promise<void>) => testWithDefaultNetwork(name, async () => {
	const { changeSimulationMode, getSettings } = await import('../../app/ts/background/settings.js')
	await changeSimulationMode({ simulationMode: (await getSettings()).simulationMode, rpcNetwork: previewRpcNetwork })
	await run()
})

const USDC_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const TRANSFERRED_USDC = 2_500_000n
const website = { websiteOrigin: 'https://invoices.example', icon: undefined, title: undefined }

type RpcRequest = { method: string, params?: readonly unknown[] }

function createSimulatorWithRpcFailure(getFailure: (rpcRequest: RpcRequest) => Error | undefined) {
	const ethereum = new modules.EthereumClientService({
		rpcUrl: previewRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: RpcRequest) {
			const failure = getFailure(rpcRequest)
			if (failure !== undefined) throw failure
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, previewRpcNetwork)
	return { ethereum, tokenPriceService: new modules.TokenPriceService(ethereum, 60_000) }
}

const createRpcError = (message: string) => new modules.JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } })

async function useInvoiceAddressBook() {
	await modules.updateUserAddressBookEntries(() => [
		{ type: 'contact', name: 'Invoice Payer', address: activeAddress, entrySource: 'User', chainId: previewRpcNetwork.chainId, useAsActiveAddress: true, askForAddressAccess: false },
		{ type: 'contact', name: 'Supplier', address: recipientAddress, entrySource: 'User', chainId: previewRpcNetwork.chainId },
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
			chainId: previewRpcNetwork.chainId,
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
	await openUsdcTransferConfirmation(createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES, previewRpcNetwork))

	const popupVisualisation = await getPendingFailedTransactionVisualisation()
	if (popupVisualisation.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	assert.match(popupVisualisation.data.error.message, /max fee per gas less than block base fee/u)
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview)
})

test('resolves address-book names and parses calldata when the transaction could not be formed', async () => {
	await useInvoiceAddressBook()
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = (await refreshConfirmTransactionSimulation(
		simulator.ethereum,
		simulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		await createUnformedUsdcTransfer(7n),
	))?.popupVisualisation

	assert.equal(popupVisualisation?.statusCode, 'success')
	assert.equal(popupVisualisation?.data.transactionToSimulate.success, false)
	assertUsdcTransferPreview(popupVisualisation?.data.failedTransactionPreview)
})

test('gives the runs of a restarted background a new lifetime while their sequence starts over', async () => {
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	// A query string evaluates the module again, which is what a background restart does to its run counter and lifetime.
	const restartedModulePath: string = '../../app/ts/background/confirmTransactionSimulation.js?background-restart'
	const restartedBackground: typeof import('../../app/ts/background/confirmTransactionSimulation.js') = await import(restartedModulePath)
	const simulateRun = async (simulate: typeof refreshConfirmTransactionSimulation) => {
		const popupVisualisation = (await simulate(simulator.ethereum, simulator.tokenPriceService, activeAddress, true, uniqueRequestIdentifier, await createUnformedUsdcTransfer(7n)))?.popupVisualisation
		if (popupVisualisation === undefined) throw new Error('The confirmation simulation was cancelled')
		return popupVisualisation.data.confirmationRunId
	}

	const runBeforeRestart = await simulateRun(refreshConfirmTransactionSimulation)
	const runAfterRestart = await simulateRun(restartedBackground.refreshConfirmTransactionSimulation)

	assert.equal(runAfterRestart.sequence, 1)
	assert.notEqual(runAfterRestart.lifetime, runBeforeRestart.lifetime)
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

test('neither names nor probes the EIP-7702 delegation target of a formed transaction, which the failure view does not show', async () => {
	await useInvoiceAddressBook()
	const { getFailedTransactionPreview } = await import('../../app/ts/background/simulationUpdating.js')
	const transfer = await createFormedUsdcTransfer(100n)
	const unknownDelegationTarget = 0x7777777777777777777777777777777777777777n
	const probedAddresses: unknown[] = []
	const recordingSimulator = createSimulatorWithRpcFailure((rpcRequest) => {
		if (rpcRequest.method === 'eth_getCode') probedAddresses.push(rpcRequest.params?.[0])
		return undefined
	})
	const delegatingTransfer: WebsiteCreatedEthereumTransaction['transaction'] = {
		type: '7702',
		from: activeAddress,
		chainId: previewRpcNetwork.chainId,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 60_000n,
		to: USDC_ADDRESS,
		value: 0n,
		input: transfer.transaction.input,
		accessList: [],
		authorizationList: [{ address: unknownDelegationTarget, chainId: 1n, nonce: 0n }],
	}
	const preview = await getFailedTransactionPreview(recordingSimulator.ethereum, undefined, { ...transfer, transaction: delegatingTransfer })
	assert.equal(preview.addressBookEntries.some((entry) => entry.address === unknownDelegationTarget), false)
	assert.equal(probedAddresses.includes(unknownDelegationTarget), false)
	assert.equal((await modules.getUserAddressBookEntries()).some((entry) => entry.address === unknownDelegationTarget), false)
})

test('names the sender the failure view shows, the request\'s, when forming the transaction filled in the active address', async () => {
	await useInvoiceAddressBook()
	const { getFailedTransactionPreview } = await import('../../app/ts/background/simulationUpdating.js')
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transfer = await createFormedUsdcTransfer(16n)
	const requestedSender = 0x5555555555555555555555555555555555555555n
	const transferCall = { to: addressString(USDC_ADDRESS), value: '0x0', data: encodeFunctionCall(Erc20ABI, 'transfer', [addressString(recipientAddress), TRANSFERRED_USDC]) }
	const requests = [
		{ shownSender: undefined, request: transferCall },
		{ shownSender: requestedSender, request: { ...transferCall, from: addressString(requestedSender) } },
	]
	for (const { shownSender, request } of requests) {
		// The formed transaction is sent from the active address, as when the request omits its sender or signing mode replaces it.
		const preview = await getFailedTransactionPreview(simulator.ethereum, undefined, { ...transfer, originalRequestParameters: SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [request] }) })
		const namedAddresses = preview.addressBookEntries.map((entry) => entry.address)
		assert.equal(namedAddresses.includes(activeAddress), false, 'the filled-in sender the view does not show is not named')
		assert.equal(namedAddresses.includes(recipientAddress), true)
		if (shownSender !== undefined) assert.equal(namedAddresses.includes(shownSender), true, 'the requested sender the view shows is named')
	}
})

test('neither names, parses nor probes anything for a failed raw transaction, whose failure view shows only its signed bytes', async () => {
	await useInvoiceAddressBook()
	const { Transaction } = await import('micro-eth-signer')
	const { SendRawTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { formSendRawTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const unknownRecipient = 0x7777777777777777777777777777777777777777n
	const signedTransfer = Transaction.prepare({
		type: 'eip1559',
		chainId: 1n,
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gasLimit: 60_000n,
		to: addressString(USDC_ADDRESS),
		value: 0n,
		accessList: [],
		data: encodeFunctionCall(Erc20ABI, 'transfer', [addressString(unknownRecipient), TRANSFERRED_USDC]),
	}, false).signBy('0x0000000000000000000000000000000000000000000000000000000000000001').toHex()
	const formedRawTransaction = await formSendRawTransaction(simulator.ethereum, SendRawTransactionParams.parse({ method: 'eth_sendRawTransaction', params: [signedTransfer] }), website, created, 99n)
	const probedAddresses: unknown[] = []
	const failingSimulator = createSimulatorWithRpcFailure((rpcRequest) => {
		if (rpcRequest.method === 'eth_getCode') probedAddresses.push(rpcRequest.params?.[0])
		return rpcRequest.method === 'eth_getBlockByNumber' ? createRpcError('block lookup unavailable') : undefined
	})
	const popupVisualisation = (await refreshConfirmTransactionSimulation(failingSimulator.ethereum, failingSimulator.tokenPriceService, activeAddress, true, uniqueRequestIdentifier, formedRawTransaction))?.popupVisualisation
	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected the raw transaction confirmation to fail')
	assert.equal(popupVisualisation.data.error.message, 'block lookup unavailable')
	assert.deepEqual(popupVisualisation.data.failedTransactionPreview?.addressBookEntries, [])
	assert.equal(popupVisualisation.data.failedTransactionPreview?.parsedInputData.type, 'NonParsed')
	assert.deepEqual(probedAddresses, [])
	assert.equal((await modules.getUserAddressBookEntries()).some((entry) => entry.address === unknownRecipient), false)
})

test('resolves address-book names and parses calldata when the confirmation simulation throws', async () => {
	await useInvoiceAddressBook()
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = (await refreshConfirmTransactionSimulation(
		createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_getBalance' ? createRpcError('balance lookup unavailable') : undefined).ethereum,
		simulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		await createFormedUsdcTransfer(9n),
	))?.popupVisualisation

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
	const transferRequest = await getUsdcTransferParams()
	const creationRequest: SendTransactionParams = { method: 'eth_sendTransaction', params: [{ ...transferRequest.params[0], to: null }] }
	const contractCreation = { ...transfer, originalRequestParameters: creationRequest, transaction: { ...transfer.transaction, to: null } }
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

test('keeps a website-chosen calldata address in the address book only as the untrusted on-chain entry the metadata lookup of a successful simulation already keeps for it', async () => {
	const websiteChosenAddress = 0x6666666666666666666666666666666666666666n
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { getFailedTransactionPreview } = await import('../../app/ts/background/simulationUpdating.js')
	const { getAddressBookEntriesForVisualiserFromTransactions } = await import('../../app/ts/background/metadataUtils.js')
	const { parseInputData } = await import('../../app/ts/simulation/parsing.js')
	const request = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(USDC_ADDRESS), value: '0x0', data: encodeFunctionCall(Erc20ABI, 'transfer', [addressString(websiteChosenAddress), TRANSFERRED_USDC]) }],
	})
	const formedTransfer = await createFormedUsdcTransfer(18n)
	const signedTransaction = modules.mockSignTransaction({ ...formedTransfer.transaction, input: request.params[0].data ?? new Uint8Array() })
	const getKeptEntry = async () => (await modules.getUserAddressBookEntries()).find((entry) => entry.address === websiteChosenAddress)

	// getMetadataForSimulation names a successful simulation's addresses this way, with the confirmed transaction appended to the simulated block.
	await useInvoiceAddressBook()
	const simulationViewEntries = await getAddressBookEntriesForVisualiserFromTransactions((address) => identifyAddress(simulator.ethereum, undefined, address), [], [await parseInputData(signedTransaction, (address) => identifyAddress(simulator.ethereum, undefined, address))], [{
		stateOverrides: {},
		signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		simulateWithZeroBaseFee: false,
		transactions: [{ signedTransaction, website, created, originalRequestParameters: request, transactionIdentifier: 18n }],
	}])
	const keptBySimulation = await getKeptEntry()
	assert.deepEqual(simulationViewEntries.find((entry) => entry.address === websiteChosenAddress), keptBySimulation)
	assert.equal(keptBySimulation?.entrySource, 'OnChain', 'the successful simulation already kept the website-chosen address, marked as an untrusted on-chain identification')

	await useInvoiceAddressBook()
	assert.equal(await getKeptEntry(), undefined)
	const failureView = await getFailedTransactionPreview(simulator.ethereum, undefined, { ...await createUnformedUsdcTransfer(18n), originalRequestParameters: request })
	const keptByFailureView = await getKeptEntry()
	assert.deepEqual(failureView.addressBookEntries.find((entry) => entry.address === websiteChosenAddress), keptByFailureView)
	assert.deepEqual(keptByFailureView, keptBySimulation, 'the failure view keeps the same untrusted entry the successful simulation keeps')
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
	return (await refreshConfirmTransactionSimulation(ethereum, simulator.tokenPriceService, activeAddress, true, uniqueRequestIdentifier, transactionToSimulate))?.popupVisualisation
}

// Each scenario reaches a different failure branch with the transfer recipient missing from the empty address book. The recipient is first looked up on chain by the failure preview, except after a failed simulation, whose own visualisation looks it up and saves it, so its failure preview then finds it locally without noticing an abort.
const supersededFailurePreviewScenarios = [
	{
		scenario: 'the confirmation simulation fails',
		createSimulator: () => createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES, previewRpcNetwork),
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

// Metadata refreshes now publish the background re-label's stored result. The former RPC-backed metadata-refresh race tests are covered by confirmTransactionMetadataRefresh.suite.ts for successful runs and by these failed-preview cases.
for (const legacyId of ['current', 'numeric', 'missing'] as const) {
	test(`re-labels a failed preview offline with a ${ legacyId } run identity and keeps its timestamp`, async () => {
		await useInvoiceAddressBook()
		const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES, previewRpcNetwork)
		await openUsdcTransferConfirmation(confirmationSimulator)
		if (legacyId !== 'current') {
			const { pendingTransactionsAndMessages } = await browser.storage.local.get('pendingTransactionsAndMessages')
			if (!Array.isArray(pendingTransactionsAndMessages)) throw new Error('Missing confirmations')
			await browser.storage.local.set({ pendingTransactionsAndMessages: pendingTransactionsAndMessages.map((pending: unknown) => {
				if (!isRecord(pending) || !isRecord(pending.popupVisualisation) || !isRecord(pending.popupVisualisation.data)) throw new Error('Missing confirmation data')
				const { confirmationRunId: _id, ...data } = pending.popupVisualisation.data
				return { ...pending, ...(legacyId === 'numeric' && isRecord(pending.confirmationRun) ? { confirmationRun: { ...pending.confirmationRun, confirmationRunId: 42 } } : {}), popupVisualisation: { ...pending.popupVisualisation, data: legacyId === 'missing' ? data : { ...data, confirmationRunId: { lifetime: '', sequence: 42 } } } }
			}) })
		}
		const before = await getPendingFailedTransactionVisualisation()
		await modules.updateUserAddressBookEntries((entries) => [...entries, { type: 'ERC20', name: 'Circle USD', symbol: 'USDC', decimals: 6n, address: USDC_ADDRESS, entrySource: 'User', chainId: previewRpcNetwork.chainId }])
		const { relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmationRelabel.js')
		const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
		const { spyOn } = await import('bun:test')
		const rpc = spyOn(fakeRequestHandler, 'jsonRpcRequest').mockImplementation(async () => { throw new Error('A metadata re-label must not request RPC') })
		try {
			await relabelDisplayedConfirmationSimulation(previewRpcNetwork)
			await refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum)
			assert.equal(rpc.mock.calls.length, 0)
		} finally {
			rpc.mockRestore()
		}
		const after = await getPendingFailedTransactionVisualisation()
		assertUsdcTransferPreview(after.data.failedTransactionPreview, 'Circle USD')
		assert.deepEqual(after.data.confirmationRunId, before.data.confirmationRunId)
		assert.deepEqual(after.data.simulationState, before.data.simulationState)
		assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_metadata'), true)
		if (legacyId === 'numeric') {
			const [pending] = await modules.getPendingTransactionsAndMessages()
			if (pending?.type !== 'Transaction') throw new Error('Missing transaction')
			assert.deepEqual(pending.confirmationRun?.confirmationRunId, { lifetime: '', sequence: 42 })
		}
	})
}

for (const replacement of ['new-run', 'same-run'] as const) {
	test(`failed preview re-label preserves a ${ replacement } update stored during its address-book lookups`, async () => {
		await useInvoiceAddressBook()
		await openUsdcTransferConfirmation(createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES, previewRpcNetwork))
		const before = await getPendingFailedTransactionVisualisation()
		await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === recipientAddress ? { ...entry, name: 'Renamed supplier' } : entry))
		let replaced = false
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!replaced && (keys === 'userAddressBookEntriesV3' || Array.isArray(keys) && keys.includes('userAddressBookEntriesV3'))) {
				replaced = true
				await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
					if (current.type !== 'Transaction' || !('popupVisualisation' in current) || current.popupVisualisation.statusCode !== 'failed') throw new Error('Missing failed confirmation')
					return { ...current, popupVisualisation: { ...current.popupVisualisation, data: { ...current.popupVisualisation.data, confirmationRunId: replacement === 'new-run' ? { lifetime: 'newer background', sequence: 1 } : current.popupVisualisation.data.confirmationRunId, error: { ...current.popupVisualisation.data.error, decodedErrorMessage: 'New error detail' } } } }
				})
			}
			return readStoredItems()
		})
		try {
			const { relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmationRelabel.js')
			await relabelDisplayedConfirmationSimulation(previewRpcNetwork)
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		assert.equal(replaced, true)
		const after = await getPendingFailedTransactionVisualisation()
		if (after.statusCode !== 'failed') throw new Error('Expected a failed confirmation')
		assert.equal(after.data.error.decodedErrorMessage, 'New error detail')
		assert.equal(after.data.failedTransactionPreview?.addressBookEntries.find((entry) => entry.address === recipientAddress)?.name, replacement === 'new-run' ? 'Supplier' : 'Renamed supplier')
		assert.deepEqual(after.data.simulationState, before.data.simulationState)
	})
}


for (const scenario of ['formed-without-chain', 'unformed-other-chain', 'legacy-unformed-without-chain'] as const) {
	test(`failed preview relabel respects the recorded run network: ${ scenario }`, async () => {
		await useInvoiceAddressBook()
		await openUsdcTransferConfirmation(createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES, previewRpcNetwork))
		const unformed = await createUnformedUsdcTransfer(7n)
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
			if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.confirmationRun === undefined) throw new Error('Missing formed confirmation run')
			if (scenario === 'formed-without-chain') return { ...current, transactionToSimulate: { ...current.transactionToSimulate, transaction: { ...current.transactionToSimulate.transaction, type: 'legacy', chainId: undefined, gasPrice: 1n } } }
			if (unformed.success) throw new Error('Expected failed formation')
			const { chainId: _chainId, ...legacyRun } = current.confirmationRun
			return { ...current, transactionOrMessageCreationStatus: 'FailedToSimulate', transactionToSimulate: unformed, confirmationRun: scenario === 'legacy-unformed-without-chain' ? legacyRun : current.confirmationRun }
		})
		const before = await getPendingFailedTransactionVisualisation()
		await modules.updateUserAddressBookEntries((entries) => entries.map((entry) => entry.address === recipientAddress ? { ...entry, name: 'Renamed supplier' } : entry))
		const { relabelDisplayedConfirmationSimulation } = await import('../../app/ts/background/confirmationRelabel.js')
		await relabelDisplayedConfirmationSimulation(scenario === 'unformed-other-chain' ? { ...previewRpcNetwork, chainId: 10n } : previewRpcNetwork)
		const after = await getPendingFailedTransactionVisualisation()
		if (scenario === 'formed-without-chain') assert.equal(after.data.failedTransactionPreview?.addressBookEntries.find((entry) => entry.address === recipientAddress)?.name, 'Renamed supplier')
		else assert.deepEqual(after, before)
	})
}

import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import type { WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../../app/ts/types/visualizer-types.js'
import { activeAddress, addressString, created, createFeeValidatingSimulator, createSafeAddressBookEntry, createSafeTx, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, getSafeTxHash, modules, recipientAddress, simulator, TOO_LITTLE_ETH_FOR_FEES, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

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

// Runs a newer refresh the first time the address is looked up on chain, while the superseded refresh resolves its failure preview. Afterwards the lookup either rejects the way the RPC request handler rejects an aborted request, or resolves the way a cached lookup does.
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

async function openUsdcTransferConfirmation(confirmationSimulator: ReturnType<typeof createFeeValidatingSimulator>) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: activeAddress })
	const transactionParams = await getUsdcTransferParams()
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

test('does not refresh the metadata of a confirmation stored without a simulation run id', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	// Stores the confirmation the way versions without simulation run ids did, which a metadata refresh cannot tell apart from a newer run.
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => {
		if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'failed') return pending
		const { simulationId: _simulationId, ...dataWithoutSimulationId } = pending.popupVisualisation.data
		return { ...pending, popupVisualisation: { statusCode: 'failed', data: dataWithoutSimulationId } }
	})
	await modules.updateUserAddressBookEntries((entries) => [
		...entries,
		{ type: 'ERC20', name: 'Circle USD', symbol: 'USDC', decimals: 6n, address: USDC_ADDRESS, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])

	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, undefined))

	const popupVisualisation = await getPendingFailedTransactionVisualisation()
	assert.equal(popupVisualisation.data.simulationId, undefined)
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview, 'USDC')
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

const SAFE_REFUND_RECEIVER_ADDRESS = 0x5555555555555555555555555555555555555555n
const createRevertingSafeProposalSimulator = () => createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_simulateV1' ? createRpcError('execution reverted: GS013') : undefined)

// Refreshes a Gnosis Safe proposal whose gas refund in USDC goes to a receiver that only the Safe signing request names.
async function refreshSafeProposalSimulation(ethereum: InstanceType<typeof modules.EthereumClientService>) {
	const proposedSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTx = { ...proposedSafeTx, message: { ...proposedSafeTx.message, gasToken: USDC_ADDRESS, refundReceiver: SAFE_REFUND_RECEIVER_ADDRESS } }
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x0', data: '0x' }],
	})
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	return await refreshConfirmTransactionSimulation(
		ethereum,
		simulator.tokenPriceService,
		activeAddress,
		false,
		uniqueRequestIdentifier,
		{
			website,
			created,
			originalRequestParameters: transactionParams,
			transactionIdentifier: 10n,
			success: true,
			transaction: {
				type: '1559',
				from: activeAddress,
				chainId: fakeRpcNetwork.chainId,
				nonce: 0n,
				maxFeePerGas: 0n,
				maxPriorityFeePerGas: 0n,
				gas: 21_000n,
				to: recipientAddress,
				value: 0n,
				input: new Uint8Array(),
				accessList: [],
			},
		},
		{
			safeAddress: activeAddress,
			safeSignerAddress: recipientAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
			executionGasLimit: 21_000n,
		},
	)
}

test('resolves the Gnosis Safe signing request addresses when a Safe proposal simulation fails', async () => {
	await modules.updateUserAddressBookEntries(() => [
		createSafeAddressBookEntry(),
		{ type: 'contact', name: 'Supplier', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
		{ type: 'contact', name: 'Refund Desk', address: SAFE_REFUND_RECEIVER_ADDRESS, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])
	const popupVisualisation = await withSilencedConsole(async () => await refreshSafeProposalSimulation(createRevertingSafeProposalSimulator().ethereum))

	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected the Safe proposal simulation to fail')
	const entries = popupVisualisation.data.failedTransactionPreview?.addressBookEntries ?? []
	const findName = (address: bigint) => entries.find((entry) => entry.address === address)?.name
	assert.equal(findName(activeAddress), 'Treasury Safe')
	assert.equal(findName(recipientAddress), 'Supplier')
	assert.equal(findName(USDC_ADDRESS), 'USDC')
	assert.equal(findName(SAFE_REFUND_RECEIVER_ADDRESS), 'Refund Desk')
})

test('reports an unexpected failure preview error and still returns the failure view', async () => {
	const unknownContractAddress = 0x4444444444444444444444444444444444444444n
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const { getLatestUnexpectedError } = await import('../../app/ts/background/storageVariables.js')
	const brokenMetadataSimulator = createSimulatorWithRpcFailure((rpcRequest) => (
		rpcRequest.method === 'eth_getCode' && rpcRequest.params?.[0] === unknownContractAddress ? new Error('address probe decoder defect') : undefined
	))
	const popupVisualisation = await withSilencedConsole(async () => await refreshConfirmTransactionSimulation(
		brokenMetadataSimulator.ethereum,
		brokenMetadataSimulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		{
			website,
			created,
			originalRequestParameters: SendTransactionParams.parse({
				method: 'eth_sendTransaction',
				params: [{ from: addressString(activeAddress), to: addressString(unknownContractAddress), value: '0x0', data: '0x' }],
			}),
			transactionIdentifier: 11n,
			success: false,
			error: { code: -32000, message: 'execution reverted' },
		},
	))

	assert.equal(popupVisualisation?.statusCode, 'success')
	assert.equal(popupVisualisation?.data.transactionToSimulate.success, false)
	assert.equal(popupVisualisation?.data.failedTransactionPreview, undefined)
	const unexpectedError = await getLatestUnexpectedError()
	assert.equal(unexpectedError?.data.code, 'failed_transaction_preview_failed')
	assert.equal(unexpectedError?.data.message, 'address probe decoder defect')
})

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

// Each scenario reaches a different failure branch, and its failure preview looks up an address that the empty address book does not name and the simulation did not already resolve.
const supersededFailurePreviewScenarios = [
	{
		scenario: 'a Safe proposal simulation fails',
		lookedUpAddress: SAFE_REFUND_RECEIVER_ADDRESS,
		createSimulator: createRevertingSafeProposalSimulator,
		refresh: refreshSafeProposalSimulation,
	},
	{
		scenario: 'the transaction could not be formed',
		lookedUpAddress: recipientAddress,
		createSimulator: () => simulator,
		refresh: async (ethereum: InstanceType<typeof modules.EthereumClientService>) => await refreshUsdcTransferSimulation(ethereum, await createUnformedUsdcTransfer(12n)),
	},
	{
		scenario: 'the confirmation simulation throws',
		lookedUpAddress: recipientAddress,
		createSimulator: () => createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_getBalance' ? createRpcError('balance lookup unavailable') : undefined),
		refresh: async (ethereum: InstanceType<typeof modules.EthereumClientService>) => await refreshUsdcTransferSimulation(ethereum, await createFormedUsdcTransfer(13n)),
	},
]

for (const { scenario, lookedUpAddress, createSimulator, refresh } of supersededFailurePreviewScenarios) {
	for (const supersededLookupOutcome of SUPERSEDED_LOOKUP_OUTCOMES) {
		test(`returns no result from a refresh superseded during its failure preview lookup when ${ scenario } and the lookup ${ supersededLookupOutcome }`, async () => {
			await modules.updateUserAddressBookEntries(() => [])
			const failingSimulator = createSimulator()
			let newerRefreshResult: Awaited<ReturnType<typeof refresh>>
			const ethereumSupersededDuringPreview = supersedeDuringAddressLookup(failingSimulator.ethereum, lookedUpAddress, supersededLookupOutcome, async () => {
				newerRefreshResult = await refresh(failingSimulator.ethereum)
			})

			const supersededRefreshResult = await withSilencedConsole(async () => await refresh(ethereumSupersededDuringPreview))

			assert.notEqual(newerRefreshResult, undefined, 'the newer refresh runs during the failure preview lookup and completes')
			assert.equal(supersededRefreshResult, undefined)
		})
	}
}

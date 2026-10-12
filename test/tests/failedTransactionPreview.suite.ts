import * as assert from 'assert'
import { test } from 'bun:test'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
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
		{
			website,
			created,
			originalRequestParameters: await getUsdcTransferParams(),
			transactionIdentifier: 7n,
			success: false,
			error: { code: -32000, message: 'execution reverted' },
		},
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

test('keeps a newer simulation result stored while the failure preview metadata refreshes', async () => {
	await useInvoiceAddressBook()
	const confirmationSimulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	await openUsdcTransferConfirmation(confirmationSimulator)
	// Forgetting the supplier makes the metadata refresh look it up on chain, which is when the newer simulation result is stored.
	await modules.updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.address !== recipientAddress))
	const newerSimulationConductedTimestamp = new Date('2030-01-01T00:00:00.000Z')
	// Stores what a new-block simulation refresh would store: a newer result for the same pending transaction.
	const storeNewerSimulationResult = async () => await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => {
		if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'failed') return pending
		const { data } = pending.popupVisualisation
		return { ...pending, popupVisualisation: { ...pending.popupVisualisation, data: {
			...data,
			error: { ...data.error, message: 'newer simulation failure' },
			simulationState: { ...data.simulationState, simulationConductedTimestamp: newerSimulationConductedTimestamp },
		} } }
	})
	const ethereumStoringNewerResultDuringLookup = new Proxy(confirmationSimulator.ethereum, {
		get(target, property, receiver) {
			if (property !== 'getCode') return Reflect.get(target, property, receiver)
			return async (...getCodeArguments: Parameters<typeof target.getCode>) => {
				if (getCodeArguments[0] === recipientAddress) await storeNewerSimulationResult()
				return await target.getCode(...getCodeArguments)
			}
		},
	})

	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	await withSilencedConsole(async () => await refreshPopupConfirmTransactionMetadata(ethereumStoringNewerResultDuringLookup, confirmationSimulator.tokenPriceService, undefined))

	const popupVisualisation = await getPendingFailedTransactionVisualisation()
	if (popupVisualisation.statusCode !== 'failed') throw new Error('Expected the newer failed simulation result')
	assert.equal(popupVisualisation.data.simulationState.simulationConductedTimestamp.getTime(), newerSimulationConductedTimestamp.getTime())
	assert.equal(popupVisualisation.data.error.message, 'newer simulation failure')
})

test('resolves address-book names and parses calldata when the confirmation simulation throws', async () => {
	await useInvoiceAddressBook()
	const transactionParams = await getUsdcTransferParams()
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_getBalance' ? createRpcError('balance lookup unavailable') : undefined).ethereum,
		simulator.tokenPriceService,
		activeAddress,
		true,
		uniqueRequestIdentifier,
		{
			website,
			created,
			originalRequestParameters: transactionParams,
			transactionIdentifier: 9n,
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
		},
	)

	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected the confirmation simulation to fail')
	assert.equal(popupVisualisation.data.error.message, 'balance lookup unavailable')
	assert.equal(popupVisualisation.data.simulationState.blockNumber, 0n, 'the simulation threw instead of returning a failed simulation state')
	assertUsdcTransferPreview(popupVisualisation.data.failedTransactionPreview)
})

test('resolves the Gnosis Safe signing request addresses when a Safe proposal simulation fails', async () => {
	const refundReceiverAddress = 0x5555555555555555555555555555555555555555n
	await modules.updateUserAddressBookEntries(() => [
		createSafeAddressBookEntry(),
		{ type: 'contact', name: 'Supplier', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
		{ type: 'contact', name: 'Refund Desk', address: refundReceiverAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId },
	])
	const proposedSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTx = { ...proposedSafeTx, message: { ...proposedSafeTx.message, gasToken: USDC_ADDRESS, refundReceiver: refundReceiverAddress } }
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x0', data: '0x' }],
	})
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const popupVisualisation = await withSilencedConsole(async () => await refreshConfirmTransactionSimulation(
		createSimulatorWithRpcFailure((rpcRequest) => rpcRequest.method === 'eth_simulateV1' ? createRpcError('execution reverted: GS013') : undefined).ethereum,
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
	))

	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected the Safe proposal simulation to fail')
	const entries = popupVisualisation.data.failedTransactionPreview?.addressBookEntries ?? []
	const findName = (address: bigint) => entries.find((entry) => entry.address === address)?.name
	assert.equal(findName(activeAddress), 'Treasury Safe')
	assert.equal(findName(recipientAddress), 'Supplier')
	assert.equal(findName(USDC_ADDRESS), 'USDC')
	assert.equal(findName(refundReceiverAddress), 'Refund Desk')
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

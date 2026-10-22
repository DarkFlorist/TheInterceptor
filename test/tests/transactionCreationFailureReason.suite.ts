import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, created, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, modules, recipientAddress, signedTransaction, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { encodeErrorString } from './errorDataFixtures.js'
import { toFunctionSelector } from '../../app/ts/utils/ethereumPrimitives.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import type { TransactionCreationError } from '../../app/ts/types/error.js'

if (activeAddress === undefined || recipientAddress === undefined) throw new Error('The confirmation test harness has no default addresses')
const senderAddress: bigint = activeAddress
const stackedTransactionRecipientAddress: bigint = recipientAddress
// Deliberately absent from the bundled address metadata, so identifying it requires on-chain probes that the fake RPC records.
const routerAddress = 0x4242424242424242424242424242424242424242n
const routerAbi = JSON.stringify([{ type: 'error', name: 'SwapDeadlinePassed', inputs: [] }])
const swapDeadlinePassedSelector = toFunctionSelector('SwapDeadlinePassed()')
const insufficientBalanceMessage = 'Insufficient USDC balance. Available: 1 USDC. Attempting to send: 2 USDC.'
const createJsonRpcError = (message: string, data: string) => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message, data } })

const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
const createSendTransactionParams = (to: bigint) => ({
	method: 'eth_sendTransaction' as const,
	params: [{ from: senderAddress, to, value: 0n, input: new Uint8Array() }] as const,
})

const createGasEstimationFailure = (error: TransactionCreationError) => ({
	website,
	created,
	originalRequestParameters: createSendTransactionParams(routerAddress),
	transactionIdentifier: 1n,
	success: false as const,
	error,
})

// A fresh client avoids the shared harness client's caches and lets one test fail chosen RPC methods.
const createSimulatorWithFailingRpcMethods = (getFailure: (method: string) => Error | undefined) => {
	const ethereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			const failure = getFailure(rpcRequest.method)
			if (failure !== undefined) throw failure
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum, tokenPriceService: new modules.TokenPriceService(ethereum, 60_000) }
}

const refreshFailedTransactionCreation = async (error: TransactionCreationError, testSimulator: typeof simulator = simulator) => {
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	return await refreshConfirmTransactionSimulation(testSimulator.ethereum, testSimulator.tokenPriceService, senderAddress, true, uniqueRequestIdentifier, createGasEstimationFailure(error))
}

const getSuccessfulVisualisationFailureReason = async (error: TransactionCreationError) => {
	const popupVisualisation = await refreshFailedTransactionCreation(error)
	if (popupVisualisation === undefined) throw new Error('The confirmation simulation did not complete')
	assert.equal(popupVisualisation.statusCode, 'success')
	return popupVisualisation.data.transactionCreationFailureReason
}

const assertRouterWasNotProbed = () => {
	assert.equal(fakeSafeContract.requestedCodeAddresses.includes(routerAddress), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_getCode'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_call'), false)
}

test('decodes gas estimation custom errors with the recipient ABI when the visualisation is built', async () => {
	await modules.updateUserAddressBookEntries((entries) => [...entries, { type: 'contract', name: 'Router', address: routerAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId, abi: routerAbi }])

	const reason = await getSuccessfulVisualisationFailureReason({ code: -32000, message: 'execution reverted', data: swapDeadlinePassedSelector })

	assert.equal(reason, 'SwapDeadlinePassed')
})

test('explains Uniswap V3 revert codes in gas estimation failure reasons without probing the recipient', async () => {
	const reason = await getSuccessfulVisualisationFailureReason({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF') })

	assert.equal(reason, 'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
	assertRouterWasNotProbed()
})

test('shows the insufficient balance override instead of the decoded revert reason', async () => {
	const reason = await getSuccessfulVisualisationFailureReason({ code: -32000, message: 'execution reverted', data: swapDeadlinePassedSelector, insufficientBalanceMessage })

	assert.equal(reason, insufficientBalanceMessage)
	assertRouterWasNotProbed()
})

test('carries the transaction creation failure reason when the simulation result reports an RPC error', async () => {
	await modules.updateInterceptorTransactionStack(() => ({ operations: [{
		type: 'Transaction',
		preSimulationTransaction: {
			signedTransaction,
			website,
			created,
			originalRequestParameters: createSendTransactionParams(stackedTransactionRecipientAddress),
			transactionIdentifier: 2n,
		},
	}] }))
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => method === 'eth_simulateV1' ? createJsonRpcError('eth_simulateV1 rejected the stack', '0x') : undefined)

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF'), insufficientBalanceMessage }, failingSimulator)

	assert.equal(popupVisualisation?.statusCode, 'failed')
	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected a failed confirmation simulation')
	assert.equal(popupVisualisation.data.simulationState.blockNumber, 123n)
	assert.equal(popupVisualisation.data.error.decodedErrorMessage, 'eth_simulateV1 rejected the stack')
	assert.equal(popupVisualisation.data.transactionCreationFailureReason, insufficientBalanceMessage)
})

test('carries the transaction creation failure reason when the simulation throws an RPC error', async () => {
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => method === 'eth_getBlockByNumber' ? createJsonRpcError('block unavailable', '0x') : undefined)

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: encodeErrorString('STF'), insufficientBalanceMessage }, failingSimulator)

	assert.equal(popupVisualisation?.statusCode, 'failed')
	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected a failed confirmation simulation')
	assert.equal(popupVisualisation.data.simulationState.blockNumber, 0n)
	assert.equal(popupVisualisation.data.error.decodedErrorMessage, 'block unavailable')
	assert.equal(popupVisualisation.data.transactionCreationFailureReason, insufficientBalanceMessage)
})

test('explains Uniswap V3 revert codes in a thrown simulation error', async () => {
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => method === 'eth_getBlockByNumber' ? createJsonRpcError('execution reverted', encodeErrorString('STF')) : undefined)

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: '0x' }, failingSimulator)

	assert.equal(popupVisualisation?.statusCode, 'failed')
	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected a failed confirmation simulation')
	assert.equal(popupVisualisation.data.error.decodedErrorMessage, 'STF - possible Uniswap V3 error: Token transfer from the sender via safeTransferFrom failed, usually due to insufficient token balance or allowance')
})

test('decodes gas estimation custom errors with the recipient ABI when the simulation throws an RPC error', async () => {
	await modules.updateUserAddressBookEntries((entries) => [...entries, { type: 'contract', name: 'Router', address: routerAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId, abi: routerAbi }])
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => method === 'eth_getBlockByNumber' ? createJsonRpcError('block unavailable', '0x') : undefined)

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: swapDeadlinePassedSelector }, failingSimulator)

	assert.equal(popupVisualisation?.statusCode, 'failed')
	if (popupVisualisation?.statusCode !== 'failed') throw new Error('Expected a failed confirmation simulation')
	assert.equal(popupVisualisation.data.transactionCreationFailureReason, 'SwapDeadlinePassed')
})

test('abandons the refresh when a new block aborts the recipient lookup after the simulation ran', async () => {
	const requestedMethods: string[] = []
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => {
		requestedMethods.push(method)
		return method === 'eth_getCode' ? new Error(NEW_BLOCK_ABORT) : undefined
	})

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: swapDeadlinePassedSelector }, failingSimulator)

	assert.equal(popupVisualisation, undefined)
	assert.deepEqual(requestedMethods.filter((method) => method === 'eth_getCode'), ['eth_getCode'])
})

test('abandons the refresh when a new block aborts the recipient lookup after the simulation threw', async () => {
	const requestedMethods: string[] = []
	const failingSimulator = createSimulatorWithFailingRpcMethods((method) => {
		requestedMethods.push(method)
		if (method === 'eth_getBlockByNumber') return createJsonRpcError('execution reverted', swapDeadlinePassedSelector)
		if (method === 'eth_getCode') return new Error(NEW_BLOCK_ABORT)
		return undefined
	})

	const popupVisualisation = await refreshFailedTransactionCreation({ code: -32000, message: 'execution reverted', data: swapDeadlinePassedSelector }, failingSimulator)

	assert.equal(popupVisualisation, undefined)
	assert.deepEqual(requestedMethods.filter((method) => method === 'eth_getCode'), ['eth_getCode'])
})

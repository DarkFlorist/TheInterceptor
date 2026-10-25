import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { activeAddress, addressString, browserMock, createDisconnectedPort, createWebsitePort, fakeBlock, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, pendingTransaction, recipientAddress, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { createDeferredValue } from './backgroundEthAccountsTestHarness.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { InterceptorStackOperation } from '../../app/ts/types/visualizer-types.js'
import { WalletSendCalls } from '../../app/ts/types/JsonRpc-types.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
const socket = { tabId: 1, connectionName: 0n }
const batchRequestIdentifier = { requestId: 77, requestSocket: socket }
const tokenAddress = 0x5555555555555555555555555555555555555555n
const transferData = `0xa9059cbb${ recipientAddress.toString(16).padStart(64, '0') }${ (5n).toString(16).padStart(64, '0') }`

const walletSendCallsRequest = {
	method: 'wallet_sendCalls',
	params: [{
		version: '2.0.0',
		chainId: `0x${ fakeRpcNetwork.chainId.toString(16) }`,
		atomicRequired: false,
		calls: [
			{ to: addressString(recipientAddress), value: '0x2' },
			{ to: addressString(tokenAddress), data: transferData },
		],
	}],
}

// wallet_sendCalls batches only exist in simulation mode; signing mode refuses them before they reach these handlers (see backgroundProviderRouting.test.ts).
async function setUpWalletSendCallsTest() {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress, websiteAccess: [{ website, access: true, addressAccess: [{ address: activeAddress, access: true }] }] })
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [activeAddress], activeSigningAddress: activeAddress, signerName: 'MetaMask' }))
	const postedMessages: unknown[] = []
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 1, providerGeneration: 1 },
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	return { postedMessages, websiteTabConnections }
}

type BatchTestConnections = Awaited<ReturnType<typeof setUpWalletSendCallsTest>>['websiteTabConnections']

async function requestBatch(websiteTabConnections: BatchTestConnections, request: unknown = walletSendCallsRequest, uniqueRequestIdentifier = batchRequestIdentifier, services = simulator) {
	const { sendCalls } = await import('../../app/ts/background/simulationModeHandlers.js')
	const walletSendCalls = WalletSendCalls.parse(request)
	return await sendCalls(services.ethereum, services.tokenPriceService, websiteTabConnections, activeAddress, walletSendCalls, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: 'wallet_sendCalls',
		params: walletSendCalls.params,
	}, website)
}

async function getPendingBatch(uniqueRequestIdentifier = batchRequestIdentifier) {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'TransactionBatch' && entry.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId)
	if (pending?.type !== 'TransactionBatch' || pending.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing simulated wallet_sendCalls batch')
	return pending
}

const getStoredPreviewConfirmationRunId = async (uniqueRequestIdentifier: typeof batchRequestIdentifier) => {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'TransactionBatch' && entry.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId)
	return pending?.type === 'TransactionBatch' && pending.transactionOrMessageCreationStatus !== 'Crafting' ? pending.popupVisualisation.data.confirmationRunId : undefined
}

// Approves like the confirmation window does, naming the preview it shows: the stored one, unless a test passes the confirmationRunId of a preview the window still shows.
async function approveBatch(websiteTabConnections: BatchTestConnections, uniqueRequestIdentifier = batchRequestIdentifier, displayedConfirmationRunId?: number) {
	const approvedConfirmationRunId = displayedConfirmationRunId ?? await getStoredPreviewConfirmationRunId(uniqueRequestIdentifier)
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier, ...(approvedConfirmationRunId === undefined ? {} : { approvedConfirmationRunId }) },
	})
}

const getWalletSendCallsReply = (postedMessages: readonly unknown[]) => postedMessages.find((message) => isRecord(message) && message.type === 'result' && message.method === 'wallet_sendCalls')

const getStackBatchTransactions = async () => (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction] : [])

const getBatchIdRecords = async () => {
	const { getWalletSendCallsBatchIds } = await import('../../app/ts/background/storageVariables.js')
	return await getWalletSendCallsBatchIds()
}

const isBatchIdInUse = async (batchId: string) => {
	const { isWalletSendCallsIdInUse } = await import('../../app/ts/background/walletSendCallsBatchIds.js')
	return await isWalletSendCallsIdInUse(website.websiteOrigin, batchId)
}

const withBatchId = (batchId: string) => ({ ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: batchId }] })

async function expectApprovalToBeInvalidated(websiteTabConnections: BatchTestConnections, postedMessages: readonly unknown[], expectedCode: number) {
	assert.equal(await approveBatch(websiteTabConnections), false)
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
	const pending = await getPendingBatch()
	assert.equal(pending.approvalStatus.status, 'SignerError')
	if (pending.approvalStatus.status !== 'SignerError') throw new Error('Missing invalidated approval status')
	assert.equal(pending.approvalStatus.code, expectedCode)
}


async function updatePendingBatch(update: (pending: PendingTransactionOrSignableMessage) => PendingTransactionOrSignableMessage) {
	await modules.updatePendingTransactionOrMessage(batchRequestIdentifier, async (pending) => update(pending))
}

const otherNetwork = { ...fakeRpcNetwork, name: 'Other Test Chain', chainId: 8453n }

// Services for another network that record their RPC requests, so a test can tell whether a batch preview was produced on that network.
function createOtherNetworkServices() {
	const requestedRpcMethods: string[] = []
	const otherNetworkEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			requestedRpcMethods.push(rpcRequest.method)
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, otherNetwork)
	return { requestedRpcMethods, ethereum: otherNetworkEthereum, tokenPriceService: new modules.TokenPriceService(otherNetworkEthereum, 60_000) }
}

type RpcRequest = { method: string, params?: readonly unknown[] }

const getSimulatedBlocks = (rpcRequest: RpcRequest): readonly unknown[] => {
	const simulationParams = rpcRequest.params?.[0]
	if (rpcRequest.method !== 'eth_simulateV1' || !isRecord(simulationParams) || !Array.isArray(simulationParams.blockStateCalls)) return []
	return simulationParams.blockStateCalls
}
const getBlockCalls = (block: unknown): readonly unknown[] => isRecord(block) && Array.isArray(block.calls) ? block.calls : []

// The simulation of the whole batch runs both prepared, and therefore signed, calls in one block. Preparing a call estimates its gas with an unsigned call, so preparation never matches.
function isWholeBatchSimulation(rpcRequest: RpcRequest) {
	return getSimulatedBlocks(rpcRequest).some((block) => {
		const batchCalls = getBlockCalls(block).filter((call) => isRecord(call) && (call.to === recipientAddress || call.to === tokenAddress))
		return batchCalls.some((call) => isRecord(call) && call.to === recipientAddress)
			&& batchCalls.some((call) => isRecord(call) && call.to === tokenAddress)
			&& batchCalls.every((call) => isRecord(call) && 'r' in call)
	})
}

// Fails only the simulation of the whole batch, so the calls are still prepared and the failure reaches the batch simulation itself.
const failWholeBatchSimulationWith = (error: Error) => (rpcRequest: RpcRequest) => isWholeBatchSimulation(rpcRequest) ? error : undefined

const executionRevertedError = () => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })

const getPreviewChainIds = (pending: Awaited<ReturnType<typeof getPendingBatch>>) => ({
	transactions: pending.transactionsToSimulate.map((transaction) => transaction.success ? transaction.transaction.chainId : undefined),
	visualization: pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.simulationState.rpcNetwork.chainId : undefined,
})

test('simulates a wallet_sendCalls batch and only adds it to the simulation stack after Interceptor approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()

	assert.deepEqual(await requestBatch(websiteTabConnections), { type: 'doNotReply' })

	const pending = await getPendingBatch()
	assert.equal(pending.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pending.approvalStatus.status, 'WaitingForUser')
	assert.deepEqual(pending.transactionsToSimulate.map((transaction) => transaction.success ? [transaction.transaction.from, transaction.transaction.to, transaction.transaction.value, `0x${ Buffer.from(transaction.transaction.input).toString('hex') }`] : undefined), [
		[activeAddress, recipientAddress, 2n, '0x'],
		[activeAddress, tokenAddress, 0n, transferData],
	])
	if (pending.popupVisualisation.statusCode !== 'success' || !pending.popupVisualisation.data.visualizedSimulationState.success) throw new Error('Missing batch simulation')
	const simulatedCalls = pending.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions)
	assert.deepEqual(simulatedCalls.map((simulatedCall) => simulatedCall.transactionIdentifier), pending.transactionsToSimulate.map((transaction) => transaction.transactionIdentifier))
	// Protectors run over every call, not just the last one: the second call sends calldata to an address without code.
	assert.deepEqual(simulatedCalls.map((simulatedCall) => simulatedCall.transactionStatus === 'Transaction Succeeded' ? simulatedCall.quarantineReasons : undefined), [
		[],
		['Transaction to an Externally Owned Account contains calldata.'],
	])
	const { getTransactionBatchApprovalBlocker } = await import('../../app/ts/components/pages/ConfirmTransactionBatch.js')
	assert.equal(getTransactionBatchApprovalBlocker(pending), 'requiresForceSend')
	assert.equal(getTransactionBatchApprovalBlocker({ ...pending, transactionOrMessageCreationStatus: 'FailedToSimulate' }), 'notSimulated')

	// Batches are never forwarded to a signer, so a forged signer reply cannot complete one.
	const forgedSignerReply = await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', uniqueRequestIdentifier: batchRequestIdentifier, signerReply: { id: '0xforged' } },
	})
	assert.equal(forgedSignerReply, false)
	assert.equal((await getPendingBatch()).approvalStatus.status, 'WaitingForUser')
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)

	assert.equal(await approveBatch(websiteTabConnections), true)

	assert.deepEqual((await getStackBatchTransactions()).map((transaction) => transaction.transactionIdentifier), pending.transactionsToSimulate.map((transaction) => transaction.transactionIdentifier))
	assert.deepEqual(await getBatchIdRecords(), [{ websiteOrigin: website.websiteOrigin, batchId: pending.batchId, transactionIdentifiers: pending.transactionsToSimulate.map((transaction) => transaction.transactionIdentifier) }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: pending.batchId })
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal(await approveBatch(websiteTabConnections), undefined)
})

test('the confirmation queue of the transaction, message and Gnosis Safe flows leaves out wallet_sendCalls batches', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	// The transaction's confirmation window stays open, so the batch joins it instead of answering the transaction as unanswered.
	browserMock.setLiveWindowIds([pendingTransaction.popupOrTabId.id])
	await requestBatch(websiteTabConnections)
	const { getPendingTransactionsAndMessagesExceptBatches } = await import('../../app/ts/background/storageVariables.js')

	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.type), ['Transaction', 'TransactionBatch'])
	assert.deepEqual((await getPendingTransactionsAndMessagesExceptBatches()).map((pending) => pending.type), ['Transaction'])
})

test('a batch whose calls cannot be simulated cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	// Every call fails its own preparation: the gas estimate, the only simulation that runs a batch call unsigned, is refused.
	fakeSafeContract.getEthSimulateFailure = (rpcRequest) => getSimulatedBlocks(rpcRequest).some((block) => getBlockCalls(block).some((call) => isRecord(call) && (call.to === recipientAddress || call.to === tokenAddress) && !('r' in call))) ? new Error('eth_simulateV1 unavailable') : undefined

	assert.deepEqual(await withSilencedConsole(async () => await requestBatch(websiteTabConnections)), { type: 'doNotReply' })

	const pending = await getPendingBatch()
	assert.equal(pending.transactionOrMessageCreationStatus, 'FailedToSimulate')
	assert.deepEqual(pending.transactionsToSimulate.map((transaction) => transaction.success), [false, false])
	assert.equal(await approveBatch(websiteTabConnections), false)
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
})

test('the governance vote preview finds a vote sent as a call of a wallet_sendCalls batch', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const governanceAddress = 0x6666666666666666666666666666666666666666n
	// castVote(uint256 proposalId = 12, uint8 support = 1)
	const castVoteData = `0x56781388${ (12n).toString(16).padStart(64, '0') }${ (1n).toString(16).padStart(64, '0') }`
	const batchWithVote = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], calls: [walletSendCallsRequest.params[0].calls[0], { to: addressString(governanceAddress), data: castVoteData }] }] }
	assert.deepEqual(await requestBatch(websiteTabConnections, batchWithVote), { type: 'doNotReply' })
	const voteCall = (await getPendingBatch()).transactionsToSimulate[1]
	if (voteCall === undefined || !voteCall.success) throw new Error('Missing prepared vote call')

	const { simulateGovernanceContractExecutionOnPass } = await import('../../app/ts/background/popupMessageHandlers.js')
	const reply = await simulateGovernanceContractExecutionOnPass(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_simulateGovernanceContractExecution', data: { transactionIdentifier: voteCall.transactionIdentifier } })

	assert.equal(reply.data.transactionOrMessageIdentifier, voteCall.transactionIdentifier)
	// The vote was found and decoded: the preview only stops because the test governance contract has no ABI.
	assert.equal(reply.data.success, false)
	if (reply.data.success) throw new Error('Unexpected governance execution preview')
	assert.equal(reply.data.errorType, 'MissingAbi')
})

test('a metadata refresh stores the re-visualized batch preview of the same simulation run and updates the confirmation window', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const storedBatch = await getPendingBatch()
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	let queueWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTransactionsAndMessages' in items) queueWrites += 1
		writeStoredItems()
	})
	browserMock.sentMessages.length = 0

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
	browserMock.setStorageSetHandler(undefined)

	assert.equal(queueWrites, 1)
	const refreshedBatch = await getPendingBatch()
	assert.equal(refreshedBatch.popupVisualisation.statusCode, 'success')
	assert.equal(refreshedBatch.popupVisualisation.data.confirmationRunId, storedBatch.popupVisualisation.data.confirmationRunId)
	assert.deepEqual(refreshedBatch.transactionsToSimulate, storedBatch.transactionsToSimulate)
	assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'))
})

test('a metadata refresh that finishes after the batch was approved does not bring it back', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	let approvalDuringRefresh: Promise<boolean | undefined> | undefined
	// The refresh reads the settings while it re-visualizes its snapshot of the batch, so approving there lands between the snapshot and the refresh's write.
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (approvalDuringRefresh === undefined && Array.isArray(keys) && keys.includes('simulationMode')) {
			approvalDuringRefresh = approveBatch(websiteTabConnections)
			await approvalDuringRefresh
		}
		return readStoredItems()
	})

	await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
	browserMock.setStorageGetHandler(undefined)

	assert.equal(await approvalDuringRefresh, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal((await getStackBatchTransactions()).length, 2)
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.ok(isRecord(reply.result) && typeof reply.result.id === 'string')
})

test('a metadata refresh of an older batch simulation does not replace a newer simulation started in the same second', async () => {
	// Stored simulation timestamps keep only whole seconds, so with a stopped clock both simulations are stored with the same start time.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		const { websiteTabConnections } = await setUpWalletSendCallsTest()
		await requestBatch(websiteTabConnections)
		const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
		let newerSimulation: Promise<void> | undefined
		// The metadata refresh reads the settings while it re-visualizes its snapshot of the batch, so a simulation run there is stored between the snapshot and the metadata write.
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (newerSimulation === undefined && Array.isArray(keys) && keys.includes('simulationMode')) {
				fakeSafeContract.getEthSimulateFailure = failWholeBatchSimulationWith(executionRevertedError())
				newerSimulation = refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
				await newerSimulation
			}
			return readStoredItems()
		})

		await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		browserMock.setStorageGetHandler(undefined)

		assert.ok(newerSimulation !== undefined)
		const pending = await getPendingBatch()
		assert.deepEqual([pending.transactionOrMessageCreationStatus, pending.popupVisualisation.statusCode], ['Simulated', 'failed'])
		assert.equal(await approveBatch(websiteTabConnections), false)
	} finally {
		setSystemTime()
	}
})

test('an older batch simulation that fails after a newer one was stored does not replace it, even within the same second', async () => {
	// Stored simulation timestamps keep only whole seconds, so with a stopped clock both simulations are stored with the same start time.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		const { websiteTabConnections } = await setUpWalletSendCallsTest()
		await requestBatch(websiteTabConnections)
		const olderSimulationWaiting = createDeferredValue<void>()
		const olderSimulationReleased = createDeferredValue<void>()
		let olderSimulationHeld = false
		// The older run's first simulation of the whole batch waits until the newer run has stored its result, then fails. Superseding a run aborts its visualization, but not this simulation.
		const overlappingEthereum = new modules.EthereumClientService({
			...fakeRequestHandler,
			async jsonRpcRequest(rpcRequest: RpcRequest) {
				if (isWholeBatchSimulation(rpcRequest) && !olderSimulationHeld) {
					olderSimulationHeld = true
					olderSimulationWaiting.resolve()
					await olderSimulationReleased.promise
					throw executionRevertedError()
				}
				return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			},
		}, async () => undefined, async () => undefined, fakeRpcNetwork)
		const overlappingTokenPriceService = new modules.TokenPriceService(overlappingEthereum, 60_000)
		const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')

		const olderRefresh = refreshPopupConfirmTransactionSimulation(overlappingEthereum, overlappingTokenPriceService)
		await olderSimulationWaiting.promise
		await refreshPopupConfirmTransactionSimulation(overlappingEthereum, overlappingTokenPriceService)
		const newerRun = await getPendingBatch()
		olderSimulationReleased.resolve()
		await olderRefresh

		assert.equal(newerRun.popupVisualisation.statusCode, 'success')
		assert.deepEqual(await getPendingBatch(), newerRun)
		assert.equal(await approveBatch(websiteTabConnections), true)
	} finally {
		setSystemTime()
	}
})

// Services for a contract whose 0x…01 call records block.number and whose 0x…02 call reverts unless it runs in that same block.
function createBlockDependentServices() {
	const isCallWithSelectorEnding = (selectorEnding: number) => (call: unknown) => isRecord(call) && call.to === recipientAddress && call.input instanceof Uint8Array && call.input[3] === selectorEnding
	const recordsBlockNumber = isCallWithSelectorEnding(1)
	const requiresRecordedBlockNumber = isCallWithSelectorEnding(2)
	const blockDependentEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: RpcRequest) {
			const result = await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			const blocks = getSimulatedBlocks(rpcRequest)
			const requiringBlockIndex = blocks.findIndex((block) => getBlockCalls(block).some(requiresRecordedBlockNumber))
			const requiringBlockCalls = getBlockCalls(blocks[requiringBlockIndex])
			if (requiringBlockIndex < 0 || requiringBlockCalls.some(recordsBlockNumber) || !Array.isArray(result)) return result
			return result.map((block, blockIndex) => blockIndex !== requiringBlockIndex || !isRecord(block) || !Array.isArray(block.calls) ? block : {
				...block,
				calls: block.calls.map((call, callIndex) => requiresRecordedBlockNumber(requiringBlockCalls[callIndex]) ? { status: '0x0', gasUsed: '0x5208', returnData: '0x', error: { code: 3, message: 'execution reverted: different block' } } : call),
			})
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum: blockDependentEthereum, tokenPriceService: new modules.TokenPriceService(blockDependentEthereum, 60_000) }
}

const blockDependentCalls = (calls: readonly ('0xabcd0001' | '0xabcd0002')[]) => ({ ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], calls: calls.map((data) => ({ to: addressString(recipientAddress), data })) }] })

const getPreparationResults = (pending: Awaited<ReturnType<typeof getPendingBatch>>) => pending.transactionsToSimulate.map((transaction) => transaction.success ? 'prepared' : transaction.error.message)

test('each batch call is prepared in the same block as the calls before it, as the whole batch is simulated', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()

	await requestBatch(websiteTabConnections, blockDependentCalls(['0xabcd0001', '0xabcd0002']), batchRequestIdentifier, createBlockDependentServices())

	const pending = await getPendingBatch()
	assert.deepEqual(getPreparationResults(pending), ['prepared', 'prepared'])
	assert.equal(pending.transactionOrMessageCreationStatus, 'Simulated')
})

test('the first batch call is prepared in the stack block that approval adds it to', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const services = createBlockDependentServices()
	const approvedBatch = { requestId: 76, requestSocket: socket }
	await requestBatch(websiteTabConnections, blockDependentCalls(['0xabcd0001']), approvedBatch, services)
	assert.equal(await approveBatch(websiteTabConnections, approvedBatch), true)

	await requestBatch(websiteTabConnections, blockDependentCalls(['0xabcd0002']), batchRequestIdentifier, services)

	assert.deepEqual(getPreparationResults(await getPendingBatch()), ['prepared'])
})

const getPreparedNonces = (pending: Awaited<ReturnType<typeof getPendingBatch>>) => pending.transactionsToSimulate.map((transaction) => transaction.success ? transaction.transaction.nonce : undefined)

// Services whose RPC requests can be held, so a test can pause a refresh at a chosen request. Like the real request handler, a request whose abort controller was aborted fails with the abort reason.
function createServicesWithRequestHook(beforeRequest: (rpcRequest: RpcRequest) => Promise<void>) {
	const hookedEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: RpcRequest, requestAbortController?: AbortController) {
			await beforeRequest(rpcRequest)
			if (requestAbortController?.signal.aborted === true) throw new Error(String(requestAbortController.signal.reason))
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { ethereum: hookedEthereum, tokenPriceService: new modules.TokenPriceService(hookedEthereum, 60_000) }
}

// The older refresh reads the simulation stack and then pauses while preparing the calls. The stack is cleared and a newer refresh runs before the older refresh resumes, either after the newer refresh stored its preview or while the newer refresh is simulating.
async function expectNewerBatchRefreshToBeKept(olderRefreshResumes: 'afterNewerRefreshStored' | 'whileNewerRefreshSimulates') {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const approvedBatch = { requestId: 76, requestSocket: socket }
	await requestBatch(websiteTabConnections, walletSendCallsRequest, approvedBatch)
	assert.equal(await approveBatch(websiteTabConnections, approvedBatch), true)
	await requestBatch(websiteTabConnections)
	// The pending batch is first prepared on top of the two approved stack transactions.
	assert.deepEqual(getPreparedNonces(await getPendingBatch()), [2n, 3n])
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const olderRefreshPaused = createDeferredValue<void>()
	const olderRefreshReleased = createDeferredValue<void>()
	let olderRefreshHeld = false
	const olderServices = createServicesWithRequestHook(async () => {
		if (olderRefreshHeld) return
		olderRefreshHeld = true
		olderRefreshPaused.resolve()
		await olderRefreshReleased.promise
	})
	const olderRefresh = refreshPopupConfirmTransactionSimulation(olderServices.ethereum, olderServices.tokenPriceService)
	let newerRefreshHeld = false
	const newerServices = createServicesWithRequestHook(async (rpcRequest) => {
		if (olderRefreshResumes !== 'whileNewerRefreshSimulates' || newerRefreshHeld || !isWholeBatchSimulation(rpcRequest)) return
		newerRefreshHeld = true
		olderRefreshReleased.resolve()
		await olderRefresh
	})

	await olderRefreshPaused.promise
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await refreshPopupConfirmTransactionSimulation(newerServices.ethereum, newerServices.tokenPriceService)
	olderRefreshReleased.resolve()
	await olderRefresh

	assert.equal(newerRefreshHeld, olderRefreshResumes === 'whileNewerRefreshSimulates')
	assert.deepEqual(getPreparedNonces(await getPendingBatch()), [0n, 1n])
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 2)
}

test('an older batch refresh that finishes preparing after a newer refresh stored its preview does not replace it', async () => {
	await expectNewerBatchRefreshToBeKept('afterNewerRefreshStored')
})

test('an older batch refresh that finishes preparing while a newer refresh simulates does not abort it', async () => {
	await expectNewerBatchRefreshToBeKept('whileNewerRefreshSimulates')
})

test('rejecting a batch whose approval was invalidated passes the reason to the website', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	await modules.browserStorageLocalSet({ activeRpcNetwork: { ...fakeRpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, 5710)
	assert.match(typeof reply.error.message === 'string' ? reply.error.message : '', /active network changed/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('only one of two concurrent batches can claim the same id', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const requestWithId = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] }

	const replies = await Promise.all([requestBatch(websiteTabConnections, requestWithId), requestBatch(websiteTabConnections, requestWithId)])

	assert.deepEqual(replies.map((reply) => 'error' in reply ? reply.error.code : reply.type), ['doNotReply', 5720])
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
})

// The duplicate check reads the confirmation queue and the batch id records together, and then the simulation stack. The approval of the first batch adds its calls to the stack and then removes the batch from the queue; landing right before or right after the first read puts that move on either side of it.
async function expectBatchIdClaimedWhenApprovedAroundRecordRead(approval: 'beforeRecordRead' | 'afterRecordRead') {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	const pending = await getPendingBatch()
	let approvalStarted = false
	let approvalDuringDuplicateCheck: Promise<boolean | undefined> | undefined
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		// The approval's own reads, which start before its promise is assigned, pass straight through.
		if (approvalStarted || !Array.isArray(keys) || !keys.includes('pendingTransactionsAndMessages') || !keys.includes('walletSendCallsBatchIds')) return readStoredItems()
		approvalStarted = true
		const recordsBeforeApproval = readStoredItems()
		approvalDuringDuplicateCheck = approveBatch(websiteTabConnections)
		await approvalDuringDuplicateCheck
		return approval === 'beforeRecordRead' ? readStoredItems() : recordsBeforeApproval
	})

	const duplicate = await requestBatch(websiteTabConnections, withBatchId('0x01'), { requestId: 78, requestSocket: socket })
	browserMock.setStorageGetHandler(undefined)

	assert.equal(await approvalDuringDuplicateCheck, true)
	assert.equal('error' in duplicate ? duplicate.error.code : undefined, 5720)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual((await getStackBatchTransactions()).map((transaction) => transaction.transactionIdentifier), pending.transactionsToSimulate.map((transaction) => transaction.transactionIdentifier))
	assert.deepEqual((await getBatchIdRecords()).map((record) => record.batchId), ['0x01'])
}

test('a batch id stays claimed when its batch is approved right before the duplicate check reads the confirmation queue and the batch id records', async () => {
	await expectBatchIdClaimedWhenApprovedAroundRecordRead('beforeRecordRead')
})

test('a batch id stays claimed when its batch is approved right after the duplicate check reads the confirmation queue and the batch id records', async () => {
	await expectBatchIdClaimedWhenApprovedAroundRecordRead('afterRecordRead')
})

test('a batch id is in use after every storage write of its approval, whatever order the confirmation queue and the simulation stack are written in', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	// Storage is copied after each write and checked once the approval finished, because the check cannot read the simulation stack while a write to it holds the large-state lock.
	const storageAfterEachWrite: Record<string, unknown>[] = []
	browserMock.setStorageSetHandler(async (_items, writeStoredItems) => {
		writeStoredItems()
		storageAfterEachWrite.push(structuredClone(browserMock.storageState))
	})

	assert.equal(await approveBatch(websiteTabConnections), true)
	browserMock.setStorageSetHandler(undefined)

	const inUseAfterEachWrite: boolean[] = []
	for (const storedItems of storageAfterEachWrite) {
		for (const key of Object.keys(browserMock.storageState)) delete browserMock.storageState[key]
		Object.assign(browserMock.storageState, storedItems)
		inUseAfterEachWrite.push(await isBatchIdInUse('0x01'))
	}
	assert.ok(storageAfterEachWrite.some((storedItems) => 'interceptorTransactionStack' in storedItems))
	assert.deepEqual(inUseAfterEachWrite.filter((inUse) => !inUse), [])
})

test('a batch id is recorded in the storage write that queues its batch and released in the storage write that removes a rejected batch', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const queueWrites: { readonly queuedBatchIds: readonly unknown[], readonly recordedBatchIds: readonly unknown[] | undefined }[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (!Array.isArray(items.pendingTransactionsAndMessages)) return
		queueWrites.push({
			queuedBatchIds: items.pendingTransactionsAndMessages.flatMap((pending) => isRecord(pending) && pending.type === 'TransactionBatch' ? [pending.batchId] : []),
			recordedBatchIds: Array.isArray(items.walletSendCallsBatchIds) ? items.walletSendCallsBatchIds.map((record) => isRecord(record) ? record.batchId : undefined) : undefined,
		})
	})

	assert.deepEqual(await requestBatch(websiteTabConnections, withBatchId('0x01')), { type: 'doNotReply' })
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})
	browserMock.setStorageSetHandler(undefined)

	assert.deepEqual(queueWrites[0], { queuedBatchIds: ['0x01'], recordedBatchIds: ['0x01'] })
	assert.deepEqual(queueWrites.at(-1), { queuedBatchIds: [], recordedBatchIds: [] })
	assert.equal(await isBatchIdInUse('0x01'), false)
	assert.deepEqual(await requestBatch(websiteTabConnections, withBatchId('0x01'), { requestId: 78, requestSocket: socket }), { type: 'doNotReply' })
})

test('a batch whose preparation fails releases its id', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	let failedPreparation = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		// The first simulation settings snapshot is the one the batch preparation takes.
		if (failedPreparation || !Array.isArray(keys) || !keys.includes('fixedAddressRichList') || !keys.includes('websiteAccess')) return readStoredItems()
		failedPreparation = true
		throw new Error('Storage read failed')
	})

	const reply = await withSilencedConsole(async () => await requestBatch(websiteTabConnections, withBatchId('0x01')))
	browserMock.setStorageGetHandler(undefined)

	assert.equal(failedPreparation, true)
	assert.equal('error' in reply ? reply.error.code : undefined, -32603)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getBatchIdRecords(), [])
	assert.deepEqual(await requestBatch(websiteTabConnections, withBatchId('0x01'), { requestId: 78, requestSocket: socket }), { type: 'doNotReply' })
})

test('an approved batch keeps its id until its calls leave the simulation stack, and the next batch drops its record', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal(await isBatchIdInUse('0x01'), true)

	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

	assert.equal(await isBatchIdInUse('0x01'), false)
	assert.deepEqual(await requestBatch(websiteTabConnections, withBatchId('0x02'), { requestId: 78, requestSocket: socket }), { type: 'doNotReply' })
	assert.deepEqual((await getBatchIdRecords()).map((record) => record.batchId), ['0x02'])
})

test('resetting a corrupt confirmation queue frees the ids of its batches, and the next batch drops their records', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	browserMock.storageState.pendingTransactionsAndMessages = [{ type: 'corrupt' }]

	assert.deepEqual(await withSilencedConsole(async () => await modules.getPendingTransactionsAndMessages()), [])

	assert.equal(await isBatchIdInUse('0x01'), false)
	assert.deepEqual(await requestBatch(websiteTabConnections, withBatchId('0x01'), { requestId: 78, requestSocket: socket }), { type: 'doNotReply' })
	assert.deepEqual((await getBatchIdRecords()).map((record) => record.transactionIdentifiers), [(await getPendingBatch({ requestId: 78, requestSocket: socket })).transactionsToSimulate.map((transaction) => transaction.transactionIdentifier)])
})

// Answers the batch while focusing the website's tab, which the confirmation window does once its queue is empty, fails. The answer must not depend on that view work, which reports its failure instead.
async function answerBatchWhileFocusingTheWebsiteTabFails(answer: (websiteTabConnections: BatchTestConnections) => Promise<unknown>) {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	browserMock.setLiveTabIds([socket.tabId])
	const updateTab = browser.tabs.update
	browser.tabs.update = async () => { throw new Error('Transient browser tab update failure') }
	try {
		await withSilencedConsole(async () => await answer(websiteTabConnections))
	} finally {
		browser.tabs.update = updateTab
	}
	const { getPendingTerminalReplies } = await import('../../app/ts/background/pendingTerminalReplies.js')
	const { getLatestUnexpectedError } = await import('../../app/ts/background/storageVariables.js')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getPendingTerminalReplies(), [])
	assert.equal((await getLatestUnexpectedError())?.data.code, 'wallet_send_calls_confirmation_view_update_failed')
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	return reply
}

test('an approved batch is answered even when the confirmation window work after its approval fails', async () => {
	const reply = await answerBatchWhileFocusingTheWebsiteTabFails(async (websiteTabConnections) => assert.equal(await approveBatch(websiteTabConnections), true))

	assert.deepEqual(reply.result, { id: '0x01' })
	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.equal(await isBatchIdInUse('0x01'), true)
})

test('a rejected batch is answered even when the confirmation window work after its rejection fails', async () => {
	const reply = await answerBatchWhileFocusingTheWebsiteTabFails(async (websiteTabConnections) => assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	}), true))

	assert.ok(isRecord(reply.error))
	assert.equal(reply.error.code, 4001)
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.equal(await isBatchIdInUse('0x01'), false)
})

// Approves the batch while its admission focuses the confirmation window, after the preview was stored, and then fails that focus, so the admission's cleanup runs after the approval already answered the website. With an interrupted delivery, the approval's answer stays queued until the website's connection is flushed.
async function approveWhileAdmissionFocusesItsWindow(delivery: 'delivered' | 'interrupted') {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	const connection = websiteTabConnections.get(socket.tabId)?.connections[modules.websiteSocketToString(socket)]
	if (connection === undefined) throw new Error('Missing website connection')
	const websitePort = connection.port
	let approvalStarted = false
	const updateWindow = browser.windows.update
	browser.windows.update = async (...parameters: Parameters<typeof browser.windows.update>) => {
		if (approvalStarted || await getStoredPreviewConfirmationRunId(batchRequestIdentifier) === undefined) return await updateWindow(...parameters)
		approvalStarted = true
		if (delivery === 'interrupted') connection.port = createDisconnectedPort().port
		assert.equal(await approveBatch(websiteTabConnections), delivery === 'delivered')
		connection.port = websitePort
		throw new Error('Transient window focus failure')
	}
	let admissionReply: unknown
	try {
		admissionReply = await withSilencedConsole(async () => await requestBatch(websiteTabConnections, withBatchId('0x01')))
	} finally {
		browser.windows.update = updateWindow
	}

	assert.equal(approvalStarted, true)
	assert.deepEqual(admissionReply, { type: 'doNotReply' })
	if (delivery === 'interrupted') assert.equal(await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, socket), 1)
	const replies = postedMessages.filter((message) => isRecord(message) && message.type === 'result' && message.method === 'wallet_sendCalls')
	assert.deepEqual(replies.map((reply) => isRecord(reply) ? [reply.result, reply.error] : undefined), [[{ id: '0x01' }, undefined]])
	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(await isBatchIdInUse('0x01'), true)
}

test('a batch approved while its admission focuses the confirmation window is not rejected when that focus fails', async () => {
	await approveWhileAdmissionFocusesItsWindow('delivered')
})

test('a batch approved while its admission focuses the confirmation window is answered only by its queued approval when that focus fails', async () => {
	await approveWhileAdmissionFocusesItsWindow('interrupted')
})

const getCallsStatus = async (batchId: string) => {
	const { getSimulatedCallsStatus } = await import('../../app/ts/background/walletSendCalls.js')
	const { getCurrentSimulationInput, buildExecutionSimulationStateFromPreparedInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const executionState = await buildExecutionSimulationStateFromPreparedInput(await prepareSimulationInputForRpc(await getCurrentSimulationInput(), simulator.ethereum), simulator.ethereum)
	return await getSimulatedCallsStatus(simulator.ethereum, { kind: 'simulated', value: executionState }, { method: 'wallet_getCallsStatus', params: [batchId] }, website.websiteOrigin)
}

const getCallsStatusCode = async (batchId: string) => {
	const status = await getCallsStatus(batchId)
	if (status.type !== 'result') return undefined
	if ('error' in status) return status.error.code
	return isRecord(status.result) ? status.result.status : undefined
}

// Approves a batch, then restores storage as it was right after the approval added the calls to the simulation stack, as a restart at that point leaves it: the calls are on the stack and the batch is still in the confirmation queue, unanswered.
async function restoreApprovalInterruptedAfterItsCommit() {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, withBatchId('0x01'))
	let storageAfterCommit: Record<string, unknown> | undefined
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if ('interceptorTransactionStack' in items && storageAfterCommit === undefined) storageAfterCommit = structuredClone(browserMock.storageState)
	})
	assert.equal(await approveBatch(websiteTabConnections), true)
	browserMock.setStorageSetHandler(undefined)
	if (storageAfterCommit === undefined) throw new Error('The approval did not write the simulation stack')
	for (const key of Object.keys(browserMock.storageState)) delete browserMock.storageState[key]
	Object.assign(browserMock.storageState, storageAfterCommit)
	postedMessages.length = 0
	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	return { postedMessages, websiteTabConnections }
}

async function expectInterruptedApprovalToBeFinished(websiteTabConnections: BatchTestConnections, postedMessages: readonly unknown[]) {
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0x01' })
	assert.equal(reply.error, undefined)
	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(await isBatchIdInUse('0x01'), true)
	assert.equal(await getCallsStatusCode('0x01'), 200)
	const duplicate = await requestBatch(websiteTabConnections, withBatchId('0x01'), { requestId: 78, requestSocket: socket })
	assert.equal('error' in duplicate ? duplicate.error.code : undefined, 5720)
}

test('an approval interrupted after its commit is finished as approved when its missing window is answered at startup', async () => {
	const { postedMessages, websiteTabConnections } = await restoreApprovalInterruptedAfterItsCommit()

	await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)

	await expectInterruptedApprovalToBeFinished(websiteTabConnections, postedMessages)
})

test('approving again after an approval was interrupted after its commit finishes it without adding its calls twice', async () => {
	const { postedMessages, websiteTabConnections } = await restoreApprovalInterruptedAfterItsCommit()

	assert.equal(await approveBatch(websiteTabConnections), true)

	await expectInterruptedApprovalToBeFinished(websiteTabConnections, postedMessages)
})

test('rejecting a batch whose approval was interrupted after its commit finishes it as approved', async () => {
	const { postedMessages, websiteTabConnections } = await restoreApprovalInterruptedAfterItsCommit()

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})

	await expectInterruptedApprovalToBeFinished(websiteTabConnections, postedMessages)
})

test('refreshing the preview of a batch whose approval was interrupted after its commit leaves it as it is', async () => {
	const { websiteTabConnections } = await restoreApprovalInterruptedAfterItsCommit()
	const storedBatch = await getPendingBatch()

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	assert.deepEqual(await getPendingBatch(), storedBatch)
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await getStackBatchTransactions()).length, 2)
})

// After an interrupted approval the user can still remove the batch's calls from the simulation stack. Nothing was executed in simulation mode, so the batch is then resolved as not approved.
async function resolveInterruptedApprovalAfterItsCallsWereRemoved(action: 'reject' | 'noResponse') {
	const { postedMessages, websiteTabConnections } = await restoreApprovalInterruptedAfterItsCommit()
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: action === 'reject' ? { action, uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined } : { action, uniqueRequestIdentifier: batchRequestIdentifier },
	})

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, 4001)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.deepEqual(await getBatchIdRecords(), [])
	assert.equal(await isBatchIdInUse('0x01'), false)
}

test('rejecting a batch whose interrupted approval had its calls removed from the simulation stack answers 4001 and releases its id', async () => {
	await resolveInterruptedApprovalAfterItsCallsWereRemoved('reject')
})

test('no response to a batch whose interrupted approval had its calls removed from the simulation stack answers 4001 and releases its id', async () => {
	await resolveInterruptedApprovalAfterItsCallsWereRemoved('noResponse')
})

test('resetting a corrupt confirmation queue keeps the id of a batch whose interrupted approval was committed', async () => {
	await restoreApprovalInterruptedAfterItsCommit()
	browserMock.storageState.pendingTransactionsAndMessages = [{ type: 'corrupt' }]

	assert.deepEqual(await withSilencedConsole(async () => await modules.getPendingTransactionsAndMessages()), [])

	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.deepEqual((await getBatchIdRecords()).map((record) => record.batchId), ['0x01'])
	assert.equal(await isBatchIdInUse('0x01'), true)
	assert.equal(await getCallsStatusCode('0x01'), 200)
})

test('an RPC failure while refreshing a batch keeps its previous simulation', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const before = await getPendingBatch()
	const { getTransactionBatchApprovalBlocker } = await import('../../app/ts/components/pages/ConfirmTransactionBatch.js')
	fakeSafeContract.getEthSimulateFailure = failWholeBatchSimulationWith(new TypeError('Failed to fetch'))
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')

	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const after = await getPendingBatch()
	assert.equal(after.popupVisualisation.statusCode, 'success')
	assert.equal(after.popupVisualisation.data.simulationStartedTimestamp.getTime(), before.popupVisualisation.data.simulationStartedTimestamp.getTime())
	assert.equal(getTransactionBatchApprovalBlocker(after), getTransactionBatchApprovalBlocker(before))
})

test('revoked website access invalidates the batch approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	const connection = websiteTabConnections.get(socket.tabId)?.connections[modules.websiteSocketToString(socket)]
	if (connection === undefined) throw new Error('Missing website connection')
	connection.approved = false
	await modules.browserStorageLocalSet({ websiteAccess: [{ website, access: true, addressAccess: [{ address: activeAddress, access: false }] }] })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
	const pending = await getPendingBatch()
	assert.match(pending.approvalStatus.status === 'SignerError' ? pending.approvalStatus.message : '', /no longer authorized/u)
})

test('access revoked in the settings refuses the approval while the website connection still reads approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	// Access changes are saved before the website connections are reconciled, so the connection keeps its approval for a while.
	await modules.browserStorageLocalSet({ websiteAccess: [{ website, access: true, addressAccess: [{ address: activeAddress, access: false }] }] })
	assert.equal(websiteTabConnections.get(socket.tabId)?.connections[modules.websiteSocketToString(socket)]?.approved, true)

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)

	const pending = await getPendingBatch()
	assert.match(pending.approvalStatus.status === 'SignerError' ? pending.approvalStatus.message : '', /no longer authorized/u)
})

test('rejecting a wallet_sendCalls batch adds nothing to the simulation stack', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})

	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, 4001)
})

test('an account change after the batch was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	await modules.browserStorageLocalSet({ independentActiveSimulationAddress: recipientAddress })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
})

test('a network change after the batch was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	await modules.browserStorageLocalSet({ activeRpcNetwork: { ...fakeRpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)
})

test('a network round trip keeps the batch preview of the network the batch was requested for', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const otherNetworkServices = createOtherNetworkServices()
	const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')

	await modules.browserStorageLocalSet({ activeRpcNetwork: otherNetwork })
	await refreshPopupConfirmTransactionSimulation(otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService)
	await refreshPopupConfirmTransactionMetadata(otherNetworkServices.ethereum, otherNetworkServices.tokenPriceService, undefined)
	await modules.browserStorageLocalSet({ activeRpcNetwork: fakeRpcNetwork })

	// The metadata refresh still reads the other network's block number for the popup, but nothing about the batch is prepared, simulated or visualized there.
	assert.deepEqual(otherNetworkServices.requestedRpcMethods.filter((method) => method !== 'eth_blockNumber'), [])
	assert.deepEqual(getPreviewChainIds(await getPendingBatch()), { transactions: [fakeRpcNetwork.chainId, fakeRpcNetwork.chainId], visualization: fakeRpcNetwork.chainId })
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.deepEqual((await getStackBatchTransactions()).map((transaction) => transaction.signedTransaction.chainId), [fakeRpcNetwork.chainId, fakeRpcNetwork.chainId])
})

test('a batch preview from another network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const original = await getPendingBatch()
	const storePreview = async (preview: Partial<Pick<typeof original, 'transactionsToSimulate' | 'popupVisualisation'>>) => await updatePendingBatch(() => ({ ...original, ...preview, approvalStatus: { status: 'WaitingForUser' } }))
	if (original.popupVisualisation.statusCode !== 'success') throw new Error('Missing batch simulation')
	const originalVisualization = original.popupVisualisation

	await storePreview({ transactionsToSimulate: original.transactionsToSimulate.map((transaction) => transaction.success ? { ...transaction, transaction: { ...transaction.transaction, chainId: otherNetwork.chainId } } : transaction) })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)

	await storePreview({ popupVisualisation: { ...originalVisualization, data: { ...originalVisualization.data, simulationState: { ...originalVisualization.data.simulationState, rpcNetwork: otherNetwork } } } })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)

	// A failed batch simulation records no network, so it cannot show that the preview belongs to the requested network.
	await storePreview({ popupVisualisation: { statusCode: 'failed', data: { ...originalVisualization.data, error: { code: -32603, message: 'failed', decodedErrorMessage: 'failed' }, simulationState: { blockNumber: 1n, simulationConductedTimestamp: new Date() } } } })
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)

	await storePreview({})
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await getStackBatchTransactions()).length, 2)
})

test('concurrent approvals add a batch to the simulation stack only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	const approvals = await Promise.all([approveBatch(websiteTabConnections), approveBatch(websiteTabConnections)])

	assert.deepEqual(approvals, [true, undefined])
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 2)
	assert.equal(postedMessages.filter((message) => isRecord(message) && message.type === 'result' && message.method === 'wallet_sendCalls').length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

// Saves a settings change during the approval's first read of storage key `during`, counting only reads after a read of `after` when given: the settings in the first approval check, the stack inside the stack's write lock, or the account lookup that follows it there. Any of these changes must refuse the approval.
async function expectSettingsChangeDuringApprovalToRefuseIt(change: Record<string, unknown>, expectedCode: number, expectedReason: RegExp, readKeys: { readonly during: string, readonly after?: string } = { during: 'simulationMode' }) {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	let changed = false
	let afterKeyRead = readKeys.after === undefined
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const storedItems = readStoredItems()
		const readKeyList = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : []
		const readsAfterKey = afterKeyRead
		if (readKeys.after !== undefined && readKeyList.includes(readKeys.after)) afterKeyRead = true
		if (!changed && readsAfterKey && readKeyList.includes(readKeys.during)) {
			changed = true
			await modules.browserStorageLocalSet(change)
		}
		return storedItems
	})

	const approval = await approveBatch(websiteTabConnections)
	browserMock.setStorageGetHandler(undefined)

	assert.equal(changed, true)
	assert.equal(approval, false)
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
	const pending = await getPendingBatch()
	if (pending.approvalStatus.status !== 'SignerError') throw new Error('Missing invalidated approval status')
	assert.equal(pending.approvalStatus.code, expectedCode)
	assert.match(pending.approvalStatus.message, expectedReason)
	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error) && !('result' in reply))
	assert.equal(reply.error.code, expectedCode)
}

test('a switch to signing mode while the approval is being checked refuses the approval', async () => {
	await expectSettingsChangeDuringApprovalToRefuseIt({ simulationMode: false }, 4100, /switched to signing mode/u)
})

test('an account switch while the approval is being checked refuses the approval', async () => {
	await expectSettingsChangeDuringApprovalToRefuseIt({ independentActiveSimulationAddress: recipientAddress }, 4100, /active account changed/u)
})

test('a network switch while the approval is being checked refuses the approval', async () => {
	await expectSettingsChangeDuringApprovalToRefuseIt({ activeRpcNetwork: otherNetwork }, 5710, /active network changed/u)
})

test('a switch to signing mode while the approval reads the simulation stack refuses the approval', async () => {
	await expectSettingsChangeDuringApprovalToRefuseIt({ simulationMode: false }, 4100, /switched to signing mode/u, { during: 'interceptorTransactionStack' })
})

test('a switch to signing mode while the final approval check looks up the account refuses the approval', async () => {
	await expectSettingsChangeDuringApprovalToRefuseIt({ simulationMode: false }, 4100, /switched to signing mode/u, { during: `tabState_${ socket.tabId.toString() }`, after: 'interceptorTransactionStack' })
})

test('a batch queued before another batch was approved is simulated again on the new stack instead of being approved against its old preview', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	// The confirmation window stays open, so the second request is queued behind the first.
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([socket.tabId, 99])
	const firstBatch = { requestId: 76, requestSocket: socket }
	await requestBatch(websiteTabConnections, walletSendCallsRequest, firstBatch)
	await requestBatch(websiteTabConnections)
	const queuedPreview = await getPendingBatch()
	assert.equal(await approveBatch(websiteTabConnections, firstBatch), true)
	const getQueuedBatchReply = () => postedMessages.find((message) => isRecord(message) && message.method === 'wallet_sendCalls' && message.requestId === batchRequestIdentifier.requestId)

	// The queued batch was previewed on the empty stack, but would now run after the first batch.
	assert.equal(await approveBatch(websiteTabConnections), false)

	assert.equal((await getStackBatchTransactions()).length, 2)
	assert.equal(getQueuedBatchReply(), undefined)
	const refreshedPreview = await getPendingBatch()
	assert.equal(refreshedPreview.approvalStatus.status, 'WaitingForUser')
	assert.notEqual(refreshedPreview.simulatedContextFingerprint, queuedPreview.simulatedContextFingerprint)
	if (refreshedPreview.popupVisualisation.statusCode !== 'success') throw new Error('Missing refreshed batch simulation')
	const refreshedShape = getBlockShape(refreshedPreview.popupVisualisation.data.simulationState.simulationStateInput)
	assert.deepEqual(refreshedShape.map((block) => block.transactionIdentifiers.length), [4])

	assert.equal(await approveBatch(websiteTabConnections), true)
	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	assert.deepEqual(getBlockShape(await getCurrentSimulationInput()), refreshedShape)
	assert.ok(isRecord(getQueuedBatchReply()))
})

// Settings that change the batch's simulation input without touching the stack.
const newPreSimulationBlockTimeManipulation = { type: 'AddToTimestamp' as const, deltaToAdd: 3600n, deltaUnit: 'Seconds' as const }
const simulationContextChanges = [
	{ name: 'pre-simulation block time manipulation', change: async () => await (await import('../../app/ts/background/settings.js')).setPreSimulationBlockTimeManipulation(newPreSimulationBlockTimeManipulation) },
	{ name: 'rich address list', change: async () => await (await import('../../app/ts/background/settings.js')).setMakeCurrentAddressRich(true) },
]

// The parts of a simulation input that these settings change: the first block's time manipulation and whether it makes the active address rich.
const getSimulationContextOfInput = (simulationStateInput: readonly { readonly blockTimeManipulation: unknown, readonly stateOverrides: Readonly<Record<string, unknown>> }[]) => ({
	firstBlockTimeManipulation: simulationStateInput[0]?.blockTimeManipulation,
	makesActiveAddressRich: Object.keys(simulationStateInput[0]?.stateOverrides ?? {}).some((address) => BigInt(address) === activeAddress),
})

for (const { name, change } of simulationContextChanges) {
	for (const timing of ['between preview and approval', 'while the final approval check looks up the account'] as const) {
		test(`a change to the ${ name } ${ timing } makes the approval simulate the batch again`, async () => {
			const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
			await requestBatch(websiteTabConnections)
			const preview = await getPendingBatch()
			if (timing === 'between preview and approval') await change()
			let changed = timing === 'between preview and approval'
			let stackRead = false
			// The final check runs inside the stack's write lock, after the stack read, and looks up the account in the tab state.
			browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
				const storedItems = readStoredItems()
				const readKeyList = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : []
				if (readKeyList.includes('interceptorTransactionStack')) stackRead = true
				if (!changed && stackRead && readKeyList.includes(`tabState_${ socket.tabId.toString() }`)) {
					changed = true
					await change()
				}
				return storedItems
			})

			const approval = await approveBatch(websiteTabConnections)
			browserMock.setStorageGetHandler(undefined)

			assert.equal(changed, true)
			assert.equal(approval, false)
			assert.deepEqual(await getStackBatchTransactions(), [])
			assert.equal(getWalletSendCallsReply(postedMessages), undefined)
			const refreshedPreview = await getPendingBatch()
			assert.equal(refreshedPreview.approvalStatus.status, 'WaitingForUser')
			assert.notEqual(refreshedPreview.simulatedContextFingerprint, preview.simulatedContextFingerprint)
			if (preview.popupVisualisation.statusCode !== 'success' || refreshedPreview.popupVisualisation.statusCode !== 'success') throw new Error('Missing batch simulation')
			const refreshedContext = getSimulationContextOfInput(refreshedPreview.popupVisualisation.data.simulationState.simulationStateInput)
			assert.notDeepEqual(refreshedContext, getSimulationContextOfInput(preview.popupVisualisation.data.simulationState.simulationStateInput))
			assert.equal(await approveBatch(websiteTabConnections), true)
			assert.equal((await getStackBatchTransactions()).length, 2)
			const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
			assert.deepEqual(getSimulationContextOfInput(await getCurrentSimulationInput()), refreshedContext)
		})
	}
}

test('two windows approving a preview that was replaced both refuse until the replacement is approved', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const displayedConfirmationRunId = await getStoredPreviewConfirmationRunId(batchRequestIdentifier)
	await simulationContextChanges[0]?.change()

	const approvals = await Promise.all([approveBatch(websiteTabConnections, batchRequestIdentifier, displayedConfirmationRunId), approveBatch(websiteTabConnections, batchRequestIdentifier, displayedConfirmationRunId)])

	assert.deepEqual(approvals, [false, false])
	assert.deepEqual(await getStackBatchTransactions(), [])
	assert.notEqual(await getStoredPreviewConfirmationRunId(batchRequestIdentifier), displayedConfirmationRunId)
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await getStackBatchTransactions()).length, 2)
})

test('approving the displayed preview is refused while a refreshed preview is stored but not yet shown', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	// The confirmation window stays open, so the second request is queued behind the first.
	browserMock.setLiveWindowIds([99])
	browserMock.setLiveTabIds([socket.tabId, 99])
	const firstBatch = { requestId: 76, requestSocket: socket }
	await requestBatch(websiteTabConnections, walletSendCallsRequest, firstBatch)
	await requestBatch(websiteTabConnections)
	const displayedPreview = await getPendingBatch()
	assert.equal(await approveBatch(websiteTabConnections, firstBatch), true)
	// The refresh stores the queued batch's preview on the new stack, then tells the window; that message is held.
	const deliveryHeld = createDeferredValue<void>()
	const deliveryReleased = createDeferredValue<void>()
	const sendMessage = browser.runtime.sendMessage
	let held = false
	browser.runtime.sendMessage = async (message: { readonly method?: string }) => {
		if (!held && message.method === 'popup_update_confirm_transaction_dialog_pending_transactions') {
			held = true
			deliveryHeld.resolve()
			await deliveryReleased.promise
		}
		return await sendMessage(message)
	}
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const refresh = refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	try {
		await deliveryHeld.promise
		const storedPreview = await getPendingBatch()
		assert.notDeepEqual(getPreparedNonces(storedPreview), getPreparedNonces(displayedPreview))

		assert.equal(await approveBatch(websiteTabConnections, batchRequestIdentifier, displayedPreview.popupVisualisation.data.confirmationRunId), false)

		assert.equal((await getStackBatchTransactions()).length, 2)
	} finally {
		deliveryReleased.resolve()
		await refresh
		browser.runtime.sendMessage = sendMessage
	}
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await getStackBatchTransactions()).length, 4)
})

// One stack block whose transactions exceed the block gas limit is split over two RPC blocks. A batch call is estimated in the last of them while it has gas left, and otherwise in the next RPC block, as preparation places it.
for (const stackTransactionGas of [2_000_000n, 20_000_000n, 30_000_000n]) {
	test(`a batch call after a stack block of two ${ stackTransactionGas.toString() } gas transactions is estimated in the RPC block that preparation puts it in`, async () => {
		const { websiteTabConnections } = await setUpWalletSendCallsTest()
		const approvedBatch = { requestId: 76, requestSocket: socket }
		await requestBatch(websiteTabConnections, walletSendCallsRequest, approvedBatch)
		assert.equal(await approveBatch(websiteTabConnections, approvedBatch), true)
		await modules.updateInterceptorTransactionStack((stack) => ({ operations: stack.operations.map((operation) => operation.type !== 'Transaction' ? operation : {
			...operation,
			preSimulationTransaction: { ...operation.preSimulationTransaction, signedTransaction: { ...operation.preSimulationTransaction.signedTransaction, gas: stackTransactionGas } },
		}) }))
		// The node reports the peak gas of each call, which the estimate compares with the gas left in its block.
		const peakGasEthereum = new modules.EthereumClientService({
			...fakeRequestHandler,
			async jsonRpcRequest(rpcRequest: RpcRequest) {
				const result = await fakeRequestHandler.jsonRpcRequest(rpcRequest)
				if (rpcRequest.method !== 'eth_simulateV1' || !Array.isArray(result)) return result
				return result.map((block) => isRecord(block) && Array.isArray(block.calls) ? { ...block, calls: block.calls.map((call) => isRecord(call) ? { ...call, maxUsedGas: '0x5208' } : call) } : block)
			},
		}, async () => undefined, async () => undefined, fakeRpcNetwork)
		const transferRequest = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], calls: [{ to: addressString(recipientAddress), value: '0x0' }] }] }

		await requestBatch(websiteTabConnections, transferRequest, batchRequestIdentifier, { ethereum: peakGasEthereum, tokenPriceService: new modules.TokenPriceService(peakGasEthereum, 60_000) })

		const pending = await getPendingBatch()
		assert.deepEqual(getPreparationResults(pending), ['prepared'])
		assert.equal(pending.transactionOrMessageCreationStatus, 'Simulated')
		if (pending.popupVisualisation.statusCode !== 'success') throw new Error('Missing batch simulation')
		const previewShape = getBlockShape(pending.popupVisualisation.data.simulationState.simulationStateInput)
		assert.equal(await approveBatch(websiteTabConnections), true)
		const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
		assert.deepEqual(getBlockShape(await getCurrentSimulationInput()), previewShape)
	})
}

// A batch transfer whose peak gas is 21000 follows a stack transaction that leaves the given gas in its block: the reviewer's 28000, exactly the peak gas, and one unit less, which preparation moves to the next RPC block.
for (const { gasLeft, expectedRpcBlockIndex } of [{ gasLeft: 28_000n, expectedRpcBlockIndex: 0 }, { gasLeft: 21_000n, expectedRpcBlockIndex: 0 }, { gasLeft: 20_999n, expectedRpcBlockIndex: 1 }]) {
	test(`a batch call after a stack block with ${ gasLeft.toString() } gas left is estimated in the RPC block that preparation puts it in`, async () => {
		const { websiteTabConnections } = await setUpWalletSendCallsTest()
		const transferRequest = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], calls: [{ to: addressString(recipientAddress), value: '0x0' }] }] }
		const approvedBatch = { requestId: 76, requestSocket: socket }
		await requestBatch(websiteTabConnections, transferRequest, approvedBatch)
		assert.equal(await approveBatch(websiteTabConnections, approvedBatch), true)
		await modules.updateInterceptorTransactionStack((stack) => ({ operations: stack.operations.map((operation) => operation.type !== 'Transaction' ? operation : {
			...operation,
			preSimulationTransaction: { ...operation.preSimulationTransaction, signedTransaction: { ...operation.preSimulationTransaction.signedTransaction, gas: fakeBlock.gasLimit - gasLeft } },
		}) }))
		// Records the RPC block of each estimate, the only simulation that runs the batch call unsigned, and reports a peak gas of 21000 for every call.
		const estimateRpcBlockIndexes: number[] = []
		const peakGasEthereum = new modules.EthereumClientService({
			...fakeRequestHandler,
			async jsonRpcRequest(rpcRequest: RpcRequest) {
				const estimateRpcBlockIndex = getSimulatedBlocks(rpcRequest).findIndex((block) => getBlockCalls(block).some((call) => isRecord(call) && call.to === recipientAddress && !('r' in call)))
				if (estimateRpcBlockIndex >= 0) estimateRpcBlockIndexes.push(estimateRpcBlockIndex)
				const result = await fakeRequestHandler.jsonRpcRequest(rpcRequest)
				if (rpcRequest.method !== 'eth_simulateV1' || !Array.isArray(result)) return result
				return result.map((block) => isRecord(block) && Array.isArray(block.calls) ? { ...block, calls: block.calls.map((call) => isRecord(call) ? { ...call, maxUsedGas: '0x5208' } : call) } : block)
			},
		}, async () => undefined, async () => undefined, fakeRpcNetwork)

		await requestBatch(websiteTabConnections, transferRequest, batchRequestIdentifier, { ethereum: peakGasEthereum, tokenPriceService: new modules.TokenPriceService(peakGasEthereum, 60_000) })

		const pending = await getPendingBatch()
		assert.deepEqual(getPreparationResults(pending), ['prepared'])
		if (pending.popupVisualisation.statusCode !== 'success') throw new Error('Missing batch simulation')
		// The stack transaction has nonce 0 and the batch call nonce 1.
		const prepared = await peakGasEthereum.prepareEthSimulateV1Input(pending.popupVisualisation.data.simulationState.simulationStateInput, await peakGasEthereum.getBlockNumber(undefined), undefined)
		const preparedRpcBlockIndex = prepared.rpcBlocks.findIndex((block) => block.transactions.some((transaction) => transaction.signedTransaction.nonce === 1n))
		const { fitsInRpcBlock } = await import('../../app/ts/simulation/services/EthereumClientService.js')
		assert.equal(expectedRpcBlockIndex, fitsInRpcBlock(fakeBlock.gasLimit - gasLeft, 21_000n, fakeBlock.gasLimit) ? 0 : 1)
		assert.equal(preparedRpcBlockIndex, expectedRpcBlockIndex)
		assert.equal(estimateRpcBlockIndexes[estimateRpcBlockIndexes.length - 1], expectedRpcBlockIndex)
		assert.equal(await approveBatch(websiteTabConnections), true)
	})
}

// The blocks of a simulation input as the transaction identifiers in each block and the block's time manipulation.
const getBlockShape = (simulationStateInput: readonly { readonly transactions: readonly { readonly transactionIdentifier: bigint }[], readonly blockTimeManipulation: unknown }[]) => simulationStateInput.map((block) => ({
	transactionIdentifiers: block.transactions.map((transaction) => transaction.transactionIdentifier),
	blockTimeManipulation: block.blockTimeManipulation,
}))

// Approves a first batch, optionally ends the stack with more operations, then requests a second batch and compares its preview with the stack after approving it.
async function expectBatchPreviewToMatchApprovedStack(operationsAfterFirstBatch: readonly InterceptorStackOperation[]) {
	const { websiteTabConnections } = await setUpWalletSendCallsTest()
	const approvedBatch = { requestId: 76, requestSocket: socket }
	await requestBatch(websiteTabConnections, walletSendCallsRequest, approvedBatch)
	assert.equal(await approveBatch(websiteTabConnections, approvedBatch), true)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, ...operationsAfterFirstBatch] }))
	await requestBatch(websiteTabConnections)
	const pending = await getPendingBatch()
	if (pending.popupVisualisation.statusCode !== 'success') throw new Error('Missing batch simulation')
	const previewShape = getBlockShape(pending.popupVisualisation.data.simulationState.simulationStateInput)

	assert.equal(await approveBatch(websiteTabConnections), true)

	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	assert.deepEqual(previewShape, getBlockShape(await getCurrentSimulationInput()))
	return previewShape
}

test('a batch is previewed in the block where approval adds it to the simulation stack', async () => {
	// Consecutive stack transactions share a block, so the second batch joins the first one's block.
	assert.deepEqual((await expectBatchPreviewToMatchApprovedStack([])).map((block) => block.transactionIdentifiers.length), [4])
})

test('a batch after a stack time manipulation is previewed in the block that the manipulation starts', async () => {
	const blockTimeManipulation = { type: 'AddToTimestamp' as const, deltaToAdd: 60n, deltaUnit: 'Seconds' as const }
	const previewShape = await expectBatchPreviewToMatchApprovedStack([{ type: 'TimeManipulation', blockTimeManipulation }])
	assert.deepEqual(previewShape.map((block) => block.transactionIdentifiers.length), [2, 2])
	assert.deepEqual(previewShape[1]?.blockTimeManipulation, blockTimeManipulation)
})

test('switching to signing mode invalidates a batch approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)

	await modules.browserStorageLocalSet({ simulationMode: false })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
})

test('reordered or modified batch calls invalidate the approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections)
	const original = await getPendingBatch()
	const [firstCall, secondCall] = original.originalRequestParameters.params[0].calls
	if (firstCall === undefined || secondCall === undefined) throw new Error('Missing batch calls')
	const withCalls = (calls: typeof original.originalRequestParameters.params[0]['calls']) => (pending: PendingTransactionOrSignableMessage) => {
		if (pending.type !== 'TransactionBatch') return pending
		return { ...pending, originalRequestParameters: { ...pending.originalRequestParameters, params: [{ ...pending.originalRequestParameters.params[0], calls }] as const } }
	}

	await updatePendingBatch(withCalls([secondCall, firstCall]))
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, -32602)

	await updatePendingBatch((pending) => ({ ...withCalls([firstCall, { ...secondCall, value: 1n }])(pending), approvalStatus: { status: 'WaitingForUser' } }))
	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, -32602)

	await updatePendingBatch((pending) => ({ ...withCalls([firstCall, secondCall])(pending), approvalStatus: { status: 'WaitingForUser' } }))
	assert.equal(await approveBatch(websiteTabConnections), true)
	assert.equal((await getStackBatchTransactions()).length, 2)
})

test('approving a batch adds every call to the simulation stack and answers wallet_getCallsStatus locally', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest()
	await requestBatch(websiteTabConnections, { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] })
	const pending = await getPendingBatch()

	assert.equal(await approveBatch(websiteTabConnections), true)

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0x01' })
	assert.deepEqual((await getStackBatchTransactions()).map((transaction) => [transaction.transactionIdentifier, transaction.signedTransaction.to]), [
		[pending.transactionsToSimulate[0]?.transactionIdentifier, recipientAddress],
		[pending.transactionsToSimulate[1]?.transactionIdentifier, tokenAddress],
	])

	const { getSimulatedCallsStatus } = await import('../../app/ts/background/walletSendCalls.js')
	const { getCurrentSimulationInput, buildExecutionSimulationStateFromPreparedInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const executionState = await buildExecutionSimulationStateFromPreparedInput(await prepareSimulationInputForRpc(await getCurrentSimulationInput(), simulator.ethereum), simulator.ethereum)
	const status = await getSimulatedCallsStatus(simulator.ethereum, { kind: 'simulated', value: executionState }, { method: 'wallet_getCallsStatus', params: ['0x01'] }, website.websiteOrigin)
	assert.ok(status.type === 'result' && 'result' in status && isRecord(status.result))
	assert.equal(status.result.status, 200)
	assert.equal(status.result.atomic, false)
	assert.equal(Array.isArray(status.result.receipts) ? status.result.receipts.length : 0, 2)
	const otherWebsiteStatus = await getSimulatedCallsStatus(simulator.ethereum, { kind: 'simulated', value: executionState }, { method: 'wallet_getCallsStatus', params: ['0x01'] }, 'https://other.example')
	assert.equal(otherWebsiteStatus.type === 'result' && 'error' in otherWebsiteStatus ? otherWebsiteStatus.error.code : undefined, 5730)

	const duplicate = await requestBatch(websiteTabConnections, { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] })
	assert.equal('error' in duplicate ? duplicate.error.code : undefined, 5720)
})

import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { activeAddress, addressString, browserMock, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, recipientAddress, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { createDeferredValue, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
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

async function setUpWalletSendCallsTest(simulationMode: boolean) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.browserStorageLocalSet({ simulationMode, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress })
	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [activeAddress], activeSigningAddress: activeAddress, signerName: 'MetaMask' }))
	const postedMessages: unknown[] = []
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: { connectionName: socket.connectionName, confirmed: true, generation: 1, providerGeneration: 1 },
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	return { postedMessages, websiteTabConnections, port }
}

type BatchTestConnections = Awaited<ReturnType<typeof setUpWalletSendCallsTest>>['websiteTabConnections']

async function requestBatch(websiteTabConnections: BatchTestConnections, simulationMode: boolean, request: unknown = walletSendCallsRequest, uniqueRequestIdentifier = batchRequestIdentifier) {
	const { sendCalls } = await import('../../app/ts/background/simulationModeHandlers.js')
	const walletSendCalls = WalletSendCalls.parse(request)
	return await sendCalls(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, activeAddress, walletSendCalls, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: 'wallet_sendCalls',
		params: walletSendCalls.params,
	}, website, simulationMode)
}

async function getPendingBatch() {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'TransactionBatch')
	if (pending?.type !== 'TransactionBatch' || pending.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing simulated wallet_sendCalls batch')
	return pending
}

async function approveBatch(websiteTabConnections: BatchTestConnections) {
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: batchRequestIdentifier },
	})
}

const getForwardedSignerRequests = (postedMessages: readonly unknown[]) => postedMessages.filter((message) => isRecord(message) && message.type === 'forwardToSigner')

async function expectApprovalToBeInvalidated(websiteTabConnections: BatchTestConnections, postedMessages: readonly unknown[], expectedCode: number) {
	assert.equal(await approveBatch(websiteTabConnections), false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	const pending = await getPendingBatch()
	assert.equal(pending.approvalStatus.status, 'SignerError')
	if (pending.approvalStatus.status !== 'SignerError') throw new Error('Missing invalidated approval status')
	assert.equal(pending.approvalStatus.code, expectedCode)
}

async function completeWithSignerReply(websiteTabConnections: BatchTestConnections, signerReply: unknown) {
	return await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', uniqueRequestIdentifier: batchRequestIdentifier, signerReply },
	})
}

// Delivers the signer's failure through the provider bridge, the way the inpage script reports a rejected wallet_sendCalls.
async function deliverSignerFailure(websiteTabConnections: BatchTestConnections, port: browser.runtime.Port, forwardedRequest: unknown, error: { readonly code: number, readonly message: string }) {
	if (!isRecord(forwardedRequest)) throw new Error('Missing forwarded wallet_sendCalls request')
	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{ success: false, signerProviderGeneration: 1, forwardRequest: forwardedRequest, error }],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 900, requestSocket: socket },
	}, 'hasAccess', activeAddress)
}

const getWalletSendCallsReply = (postedMessages: readonly unknown[]) => postedMessages.find((message) => isRecord(message) && message.type === 'result' && message.method === 'wallet_sendCalls')

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

// Preparing each call simulates it on its own; only the simulation of the whole batch contains both calls.
function isWholeBatchSimulation(rpcRequest: RpcRequest) {
	const blockStateCalls = rpcRequest.params?.[0]
	if (rpcRequest.method !== 'eth_simulateV1' || !isRecord(blockStateCalls) || !Array.isArray(blockStateCalls.blockStateCalls)) return false
	return blockStateCalls.blockStateCalls.some((block) => isRecord(block) && Array.isArray(block.calls) && block.calls.some((call) => isRecord(call) && call.to === recipientAddress) && block.calls.some((call) => isRecord(call) && call.to === tokenAddress))
}

// Fails only the simulation of the whole batch, so the calls are still prepared and the failure reaches the batch simulation itself.
const failWholeBatchSimulationWith = (error: Error) => (rpcRequest: RpcRequest) => isWholeBatchSimulation(rpcRequest) ? error : undefined

const executionRevertedError = () => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })

const getPreviewChainIds = (pending: Awaited<ReturnType<typeof getPendingBatch>>) => ({
	transactions: pending.transactionsToSimulate.map((transaction) => transaction.success ? transaction.transaction.chainId : undefined),
	visualization: pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.simulationState.rpcNetwork.chainId : undefined,
})

test('simulates a wallet_sendCalls batch and only forwards it to the signer after Interceptor approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)

	assert.deepEqual(await requestBatch(websiteTabConnections, false), { type: 'doNotReply' })

	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
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

	// A signer reply cannot complete a batch that the Interceptor has not forwarded yet.
	assert.equal(await completeWithSignerReply(websiteTabConnections, { id: '0xforged' }), false)
	assert.equal((await getPendingBatch()).approvalStatus.status, 'WaitingForUser')

	assert.equal(await approveBatch(websiteTabConnections), true)

	const forwardedRequests = getForwardedSignerRequests(postedMessages)
	assert.deepEqual(forwardedRequests, [{
		interceptorApproved: true,
		requestId: batchRequestIdentifier.requestId,
		type: 'forwardToSigner',
		method: 'wallet_sendCalls',
		params: [{
			version: '2.0.0',
			from: addressString(activeAddress),
			chainId: `0x${ fakeRpcNetwork.chainId.toString(16) }`,
			atomicRequired: false,
			calls: [
				{ to: addressString(recipientAddress), data: '0x', value: '0x2' },
				{ to: addressString(tokenAddress), data: transferData, value: '0x0' },
			],
		}],
	}])
	assert.equal((await getPendingBatch()).approvalStatus.status, 'WaitingForSigner')
	assert.equal(await approveBatch(websiteTabConnections), false)
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)

	await completeWithSignerReply(websiteTabConnections, { id: '0xbatch' })
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0xbatch' })
})

test('a batch whose calls cannot be simulated cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	fakeSafeContract.failEthSimulate = true

	assert.deepEqual(await withSilencedConsole(async () => await requestBatch(websiteTabConnections, false)), { type: 'doNotReply' })

	const pending = await getPendingBatch()
	assert.equal(pending.transactionOrMessageCreationStatus, 'FailedToSimulate')
	assert.deepEqual(pending.transactionsToSimulate.map((transaction) => transaction.success), [false, false])
	assert.equal(await approveBatch(websiteTabConnections), false)
	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
})

test('relays a bare string bundle id from signers that implement the earlier EIP-5792 draft', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	assert.equal(await approveBatch(websiteTabConnections), true)

	await completeWithSignerReply(websiteTabConnections, '0xabc')

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0xabc' })
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('reports an error when the signer reply has no usable bundle id', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	assert.equal(await approveBatch(websiteTabConnections), true)

	await completeWithSignerReply(websiteTabConnections, { status: 'sent' })

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, -32603)
	assert.match(typeof reply.error.message === 'string' ? reply.error.message : '', /may already have submitted them/u)
})

test('a metadata refresh that finishes after the batch was approved keeps it waiting for the signer', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
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
	assert.equal((await getPendingBatch()).approvalStatus.status, 'WaitingForSigner')
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	await completeWithSignerReply(websiteTabConnections, { id: '0xbatch' })
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0xbatch' })
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('a metadata refresh of an older batch simulation does not replace a newer simulation started in the same second', async () => {
	// Stored simulation timestamps keep only whole seconds, so with a stopped clock both simulations are stored with the same start time.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		const { websiteTabConnections } = await setUpWalletSendCallsTest(false)
		await requestBatch(websiteTabConnections, false)
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
		const { websiteTabConnections } = await setUpWalletSendCallsTest(false)
		await requestBatch(websiteTabConnections, false)
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

test('returns the error of a signer without wallet_sendCalls support to the website so it can fall back', async () => {
	const { postedMessages, websiteTabConnections, port } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	assert.equal(await approveBatch(websiteTabConnections), true)
	const [forwardedRequest] = getForwardedSignerRequests(postedMessages)

	await deliverSignerFailure(websiteTabConnections, port, forwardedRequest, { code: -32601, message: 'The method "wallet_sendCalls" does not exist / is not available.' })

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, -32601)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('keeps the batch for a retry after a retryable signer error', async () => {
	const { postedMessages, websiteTabConnections, port } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	assert.equal(await approveBatch(websiteTabConnections), true)
	const [forwardedRequest] = getForwardedSignerRequests(postedMessages)

	await deliverSignerFailure(websiteTabConnections, port, forwardedRequest, { code: -32603, message: 'Internal wallet error' })

	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
	const pending = await getPendingBatch()
	assert.deepEqual(pending.approvalStatus, { status: 'SignerError', code: -32603, message: 'Internal wallet error' })
})

test('rejecting a batch after a wallet error passes the wallet error to the website', async () => {
	const { postedMessages, websiteTabConnections, port } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	assert.equal(await approveBatch(websiteTabConnections), true)
	const [forwardedRequest] = getForwardedSignerRequests(postedMessages)
	await deliverSignerFailure(websiteTabConnections, port, forwardedRequest, { code: -32000, message: 'EIP-7702 not supported' })
	assert.equal((await getPendingBatch()).approvalStatus.status, 'SignerError')

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})

	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.deepEqual([reply.error.code, reply.error.message], [-32000, 'EIP-7702 not supported'])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('only one of two concurrent simulation-mode batches can claim the same id', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest(true)
	const requestWithId = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] }

	const replies = await Promise.all([requestBatch(websiteTabConnections, true, requestWithId), requestBatch(websiteTabConnections, true, requestWithId)])

	assert.deepEqual(replies.map((reply) => 'error' in reply ? reply.error.code : reply.type), ['doNotReply', 5720])
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
})

// The duplicate check reads the confirmation queue and the simulation stack one after the other. The approval of the first batch appends it to the stack and then removes it from the queue; landing right before or right after the queue read puts that move on either side of the read.
async function expectBatchIdClaimedWhenApprovedAroundQueueRead(approval: 'beforeQueueRead' | 'afterQueueRead') {
	const { websiteTabConnections } = await setUpWalletSendCallsTest(true)
	const requestWithId = { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] }
	await requestBatch(websiteTabConnections, true, requestWithId)
	let approvalStarted = false
	let approvalDuringDuplicateCheck: Promise<boolean | undefined> | undefined
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		// The approval's own reads, which start before its promise is assigned, pass straight through.
		if (approvalStarted || !Array.isArray(keys) || !keys.includes('pendingTransactionsAndMessages')) return readStoredItems()
		approvalStarted = true
		const queueBeforeApproval = readStoredItems()
		approvalDuringDuplicateCheck = approveBatch(websiteTabConnections)
		await approvalDuringDuplicateCheck
		return approval === 'beforeQueueRead' ? readStoredItems() : queueBeforeApproval
	})

	const duplicate = await requestBatch(websiteTabConnections, true, requestWithId, { requestId: 78, requestSocket: socket })
	browserMock.setStorageGetHandler(undefined)

	assert.equal(await approvalDuringDuplicateCheck, true)
	assert.equal('error' in duplicate ? duplicate.error.code : undefined, 5720)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const stackBatchIds = (await modules.getInterceptorTransactionStack()).operations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.walletSendCallsBatchId : undefined)
	assert.deepEqual(stackBatchIds, ['0x01', '0x01'])
}

test('approving a simulation-mode batch adds it to the simulation stack before removing it from the confirmation queue', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest(true)
	await requestBatch(websiteTabConnections, true)
	const storageWrites: ('stackUpdated' | 'removedFromQueue')[] = []
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('interceptorTransactionStack' in items) storageWrites.push('stackUpdated')
		if (Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) storageWrites.push('removedFromQueue')
		writeStoredItems()
	})

	assert.equal(await approveBatch(websiteTabConnections), true)
	browserMock.setStorageSetHandler(undefined)

	// The duplicate batch id check reads the queue before the stack and relies on this order.
	assert.deepEqual(storageWrites, ['stackUpdated', 'removedFromQueue'])
})

test('a batch id stays claimed when its batch is approved right before the duplicate check reads the confirmation queue', async () => {
	await expectBatchIdClaimedWhenApprovedAroundQueueRead('beforeQueueRead')
})

test('a batch id stays claimed when its batch is approved right after the duplicate check reads the confirmation queue', async () => {
	await expectBatchIdClaimedWhenApprovedAroundQueueRead('afterQueueRead')
})

test('an RPC failure while refreshing a batch keeps its previous simulation', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
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
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	const connection = websiteTabConnections.get(socket.tabId)?.connections[modules.websiteSocketToString(socket)]
	if (connection === undefined) throw new Error('Missing website connection')
	connection.approved = false
	await modules.browserStorageLocalSet({ websiteAccess: [{ website, access: true, addressAccess: [{ address: activeAddress, access: false }] }] })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
	const pending = await getPendingBatch()
	assert.match(pending.approvalStatus.status === 'SignerError' ? pending.approvalStatus.message : '', /no longer authorized/u)
})

test('rejecting a wallet_sendCalls batch never reaches the signer', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'reject', uniqueRequestIdentifier: batchRequestIdentifier, errorString: undefined },
	})

	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply) && isRecord(reply.error))
	assert.equal(reply.error.code, 4001)
})

test('an account change after the batch was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	await modules.updateTabState(socket.tabId, (state) => ({ ...state, signerAccounts: [recipientAddress], activeSigningAddress: recipientAddress }))

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
})

test('a network change after the batch was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	await modules.browserStorageLocalSet({ activeRpcNetwork: { ...fakeRpcNetwork, chainId: fakeRpcNetwork.chainId + 1n } })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 5710)
})

test('a network round trip keeps the batch preview of the network the batch was requested for', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
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
	const [forwardedRequest] = getForwardedSignerRequests(postedMessages)
	assert.ok(isRecord(forwardedRequest) && Array.isArray(forwardedRequest.params) && isRecord(forwardedRequest.params[0]))
	assert.equal(forwardedRequest.params[0].chainId, `0x${ fakeRpcNetwork.chainId.toString(16) }`)
})

test('a batch preview from another network cannot be approved', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
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
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('concurrent approvals forward a batch to the signer only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	const approvals = await Promise.all([approveBatch(websiteTabConnections), approveBatch(websiteTabConnections)])

	assert.deepEqual(approvals, [true, false])
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
	assert.equal((await getPendingBatch()).approvalStatus.status, 'WaitingForSigner')
})

test('concurrent approvals add a simulation-mode batch to the simulation stack only once', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(true)
	await requestBatch(websiteTabConnections, true)

	const approvals = await Promise.all([approveBatch(websiteTabConnections), approveBatch(websiteTabConnections)])

	assert.deepEqual(approvals, [true, undefined])
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 2)
	assert.equal(postedMessages.filter((message) => isRecord(message) && message.type === 'result' && message.method === 'wallet_sendCalls').length, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('a signer connection change after the batch was requested invalidates its approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)

	const signerStateOwner = websiteTabConnections.get(socket.tabId)?.signerStateOwner
	if (signerStateOwner === undefined) throw new Error('Missing signer state owner')
	signerStateOwner.providerGeneration += 1

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4900)
})

test('switching from simulation to signing mode invalidates a simulation-mode batch approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(true)
	await requestBatch(websiteTabConnections, true)

	await modules.browserStorageLocalSet({ simulationMode: false })

	await expectApprovalToBeInvalidated(websiteTabConnections, postedMessages, 4100)
	assert.deepEqual((await modules.getInterceptorTransactionStack()).operations, [])
	assert.equal(getWalletSendCallsReply(postedMessages), undefined)
})

test('reordered or modified batch calls invalidate the approval', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
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
	assert.equal(getForwardedSignerRequests(postedMessages).length, 1)
})

test('approving a simulation-mode batch adds every call to the simulation stack and answers wallet_getCallsStatus locally', async () => {
	const { postedMessages, websiteTabConnections } = await setUpWalletSendCallsTest(true)
	await requestBatch(websiteTabConnections, true, { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] })
	const pending = await getPendingBatch()

	assert.equal(await approveBatch(websiteTabConnections), true)

	assert.deepEqual(getForwardedSignerRequests(postedMessages), [])
	const reply = getWalletSendCallsReply(postedMessages)
	assert.ok(isRecord(reply))
	assert.deepEqual(reply.result, { id: '0x01' })
	const stackTransactions = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction] : [])
	assert.deepEqual(stackTransactions.map((transaction) => [transaction.transactionIdentifier, transaction.walletSendCallsBatchId, transaction.signedTransaction.to]), [
		[pending.transactionsToSimulate[0]?.transactionIdentifier, '0x01', recipientAddress],
		[pending.transactionsToSimulate[1]?.transactionIdentifier, '0x01', tokenAddress],
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

	const duplicate = await requestBatch(websiteTabConnections, true, { ...walletSendCallsRequest, params: [{ ...walletSendCallsRequest.params[0], id: '0x01' }] })
	assert.equal('error' in duplicate ? duplicate.error.code : undefined, 5720)
})

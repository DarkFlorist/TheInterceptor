import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, createWebsitePort, fakeRpcNetwork, fakeSafeContract, isRecord, modules, recipientAddress, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { WalletSendCalls } from '../../app/ts/types/JsonRpc-types.js'

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

async function requestBatch(websiteTabConnections: BatchTestConnections, simulationMode: boolean, request: unknown = walletSendCallsRequest) {
	const { sendCalls } = await import('../../app/ts/background/simulationModeHandlers.js')
	const walletSendCalls = WalletSendCalls.parse(request)
	return await sendCalls(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, activeAddress, walletSendCalls, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: batchRequestIdentifier,
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

test('an RPC failure while refreshing a batch keeps its previous simulation', async () => {
	const { websiteTabConnections } = await setUpWalletSendCallsTest(false)
	await requestBatch(websiteTabConnections, false)
	const before = await getPendingBatch()
	const { getTransactionBatchApprovalBlocker } = await import('../../app/ts/components/pages/ConfirmTransactionBatch.js')
	// Only the simulation of the whole batch fails, so the calls are still prepared and the failure reaches the batch simulation itself.
	fakeSafeContract.getEthSimulateFailure = (rpcRequest) => {
		const blockStateCalls = rpcRequest.params?.[0]
		if (!isRecord(blockStateCalls) || !Array.isArray(blockStateCalls.blockStateCalls)) return undefined
		const simulatesWholeBatch = blockStateCalls.blockStateCalls.some((block) => isRecord(block) && Array.isArray(block.calls) && block.calls.some((call) => isRecord(call) && call.to === recipientAddress) && block.calls.some((call) => isRecord(call) && call.to === tokenAddress))
		return simulatesWholeBatch ? new TypeError('Failed to fetch') : undefined
	}
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

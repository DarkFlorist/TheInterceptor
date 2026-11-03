import * as assert from 'assert'
import { test } from 'bun:test'
import { InterceptorSimulationExport, InterceptorTransactionStack, type PreSimulationTransaction, toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { createExecutionSimulationState, getSimulatedTransactionByHashFromInput, getSimulatedTransactionReceipt } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createSaltSearch, getSignedTransactionForSimulation, toPreSimulationTransaction, withUniqueSimulationHash } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { appendOperationsToStack } from '../../app/ts/background/simulationStackHashes.js'
import { EthereumSignedTransactionToSignedTransaction, serializeSignedTransactionToBytes } from '../../app/ts/utils/ethereum.js'
import { keccak256 } from '../../app/ts/utils/ethereumPrimitives.js'
import { addressString, browserMock, createSafeStackTransactionFixture, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, isRecord, modules, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'

// Regression tests for #1713: no two transactions on the simulation stack share a hash, so transaction and receipt lookups by hash find the right one.
const SENDER = 0x7100000000000000000000000000000000000071n
const OTHER_SENDER = 0x7200000000000000000000000000000000000072n
const RECIPIENT = 0x7300000000000000000000000000000000000073n
const WEBSITE = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
const REQUEST_SOCKET = { tabId: 1, connectionName: 0n }

const createTransferParams = async (value: bigint) => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{ to: addressString(RECIPIENT), value: `0x${ value.toString(16) }`, data: '0x' }],
})

function createWebsiteTabConnections(postedMessages: unknown[]) {
	return new Map([[REQUEST_SOCKET.tabId, {
		connections: {
			[modules.websiteSocketToString(REQUEST_SOCKET)]: {
				port: createWebsitePort(REQUEST_SOCKET, 0, postedMessages),
				socket: REQUEST_SOCKET,
				websiteOrigin: WEBSITE.websiteOrigin,
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
}

const CONFIRMATION_WINDOW_ID = 99

async function startSimulationStack(activeSimulationAddress: bigint) {
	// The confirmation window stays open, so a confirmation opened while another is pending queues behind it.
	browserMock.setLiveWindowIds([CONFIRMATION_WINDOW_ID])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
}

// Opens a simulation-mode confirmation of an eth_sendTransaction from the active simulation address, as a page's request does.
async function openConfirmation(requestId: number, from: bigint, value: bigint, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) {
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: from })
	const transactionParams = await createTransferParams(value)
	const uniqueRequestIdentifier = { requestId, requestSocket: REQUEST_SOCKET }
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, method: transactionParams.method, params: transactionParams.params },
		{ kind: 'transaction', parameters: transactionParams },
		true,
		from,
		WEBSITE,
		websiteTabConnections,
	)), { type: 'doNotReply' })
	return uniqueRequestIdentifier
}

// Accepts a pending confirmation and returns the transaction it stacked and the hash the page got.
async function acceptConfirmation(uniqueRequestIdentifier: Awaited<ReturnType<typeof openConfirmation>>, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>, postedMessages: unknown[]) {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((request) => request.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated pending transaction, got ${ pending?.transactionOrMessageCreationStatus }`)
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}))
	const stacked = (await modules.getInterceptorTransactionStack()).operations.find((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pending.transactionIdentifier)
	if (stacked?.type !== 'Transaction') throw new Error('Expected the accepted transaction on the simulation stack')
	const reply = postedMessages.find((message) => isRecord(message) && message.requestId === uniqueRequestIdentifier.requestId && 'result' in message)
	if (!isRecord(reply) || typeof reply.result !== 'string') throw new Error(`Expected the page to get a transaction hash, got ${ JSON.stringify(reply) }`)
	return { stacked: stacked.preSimulationTransaction, pageHash: BigInt(reply.result) }
}

const getStackedTransactions = async () => (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction] : [])

// Checks that every stacked transaction has its own hash and is found by it, both as a transaction and as a receipt.
async function assertEachStackedTransactionFoundByOwnHash() {
	const stackedTransactions = await getStackedTransactions()
	assert.equal(new Set(stackedTransactions.map((transaction) => transaction.signedTransaction.hash)).size, stackedTransactions.length, 'every stacked transaction has its own hash')
	const { getCurrentSimulationInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const preparedInput = await prepareSimulationInputForRpc(await getCurrentSimulationInput(), simulator.ethereum)
	const executionState = await createExecutionSimulationState(simulator.ethereum, undefined, preparedInput)
	for (const [index, stacked] of stackedTransactions.entries()) {
		const lookedUp = await getSimulatedTransactionByHashFromInput(simulator.ethereum, undefined, toResolvedSimulationInput(preparedInput), stacked.signedTransaction.hash)
		assert.equal(lookedUp?.hash, stacked.signedTransaction.hash)
		assert.equal(lookedUp?.from, stacked.signedTransaction.from)
		assert.equal(lookedUp?.nonce, stacked.signedTransaction.nonce)
		assert.equal(lookedUp?.value, stacked.signedTransaction.value)
		const receipt = await getSimulatedTransactionReceipt(simulator.ethereum, undefined, toResolvedExecutionSimulationState(executionState), stacked.signedTransaction.hash)
		assert.equal(receipt?.transactionHash, stacked.signedTransaction.hash)
		assert.equal(receipt?.transactionIndex, BigInt(index), 'the receipt is the transaction\'s own')
	}
	return stackedTransactions
}

const DUPLICATE_COUNT = 200
const getSalt = (transaction: PreSimulationTransaction) => transaction.signedTransaction.r >> 160n
const hashesOf = (transactions: readonly PreSimulationTransaction[]) => transactions.map((transaction) => transaction.signedTransaction.hash)

test('gives a transaction appended after a removal renumbered its sender\'s nonces a hash apart from the renumbered transaction', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await acceptConfirmation(await openConfirmation(1, SENDER, 1n, websiteTabConnections), websiteTabConnections, postedMessages)
	const second = await acceptConfirmation(await openConfirmation(2, SENDER, 2n, websiteTabConnections), websiteTabConnections, postedMessages)
	assert.deepEqual([first.stacked.signedTransaction.nonce, second.stacked.signedTransaction.nonce], [0n, 1n])

	await (await import('../../app/ts/background/popupMessageHandlers.js')).removeTransactionOrSignedMessage(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_removeTransactionOrSignedMessage', data: { type: 'Transaction', transactionIdentifier: first.stacked.transactionIdentifier } })
	const [renumbered] = await getStackedTransactions()
	assert.equal(renumbered?.signedTransaction.nonce, 0n, 'removal renumbers the later transaction')
	assert.equal(renumbered?.signedTransaction.hash, second.pageHash, 'and keeps the hash the page already has')

	// The same fields as the renumbered transaction had, at the nonce it had, so mock signing alone gives the renumbered transaction's hash.
	const appendedRequest = await openConfirmation(3, SENDER, 2n, websiteTabConnections)
	const appendedPending = (await modules.getPendingTransactionsAndMessages()).find((pending) => pending.uniqueRequestIdentifier.requestId === appendedRequest.requestId)
	if (appendedPending?.type !== 'Transaction' || appendedPending.popupVisualisation === undefined || appendedPending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a successful preview of the appended transaction')
	const previewedHash = appendedPending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.transactions.at(-1)?.signedTransaction.hash
	const appended = await acceptConfirmation(appendedRequest, websiteTabConnections, postedMessages)
	assert.equal(previewedHash, appended.pageHash, 'the preview shows the hash accepting stores')
	assert.equal(appended.stacked.signedTransaction.nonce, 1n)
	assert.equal(modules.mockSignTransaction({ ...appended.stacked.signedTransaction }).hash, second.pageHash, 'the appended transaction is the case that collided')
	assert.notEqual(appended.pageHash, second.pageHash)
	assert.equal(appended.pageHash, appended.stacked.signedTransaction.hash, 'the page gets the hash the transaction was stacked with')
	assert.deepEqual(hashesOf(await assertEachStackedTransactionFoundByOwnHash()), [second.pageHash, appended.pageHash])
})

test('gives identical transactions from different senders at the same nonce different hashes', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const fromSender = await acceptConfirmation(await openConfirmation(1, SENDER, 1n, websiteTabConnections), websiteTabConnections, postedMessages)
	const fromOtherSender = await acceptConfirmation(await openConfirmation(2, OTHER_SENDER, 1n, websiteTabConnections), websiteTabConnections, postedMessages)
	const { from: _from, hash: _hash, r: _r, ...senderFields } = fromSender.stacked.signedTransaction
	const { from: _otherFrom, hash: _otherHash, r: _otherR, ...otherSenderFields } = fromOtherSender.stacked.signedTransaction
	assert.deepEqual(senderFields, otherSenderFields, 'the two transactions differ only in their sender')
	assert.deepEqual([fromSender.stacked.signedTransaction.r, fromOtherSender.stacked.signedTransaction.r], [SENDER, OTHER_SENDER], 'the mock signature carries the sender')
	assert.notEqual(fromSender.pageHash, fromOtherSender.pageHash)
	assert.deepEqual(hashesOf(await assertEachStackedTransactionFoundByOwnHash()), [fromSender.pageHash, fromOtherSender.pageHash])
})

const getPreviewedHash = async (requestId: number) => {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((request) => request.uniqueRequestIdentifier.requestId === requestId)
	if (pending?.type !== 'Transaction' || pending.popupVisualisation === undefined || pending.popupVisualisation.statusCode !== 'success') throw new Error('Expected a successful preview')
	return pending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.transactions.at(-1)?.signedTransaction.hash
}

test('gives two identical confirmations that were pending at once distinct hashes, each the one its preview showed', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const firstRequest = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const secondRequest = await openConfirmation(2, SENDER, 1n, websiteTabConnections)
	const pendingTransactions = (await modules.getPendingTransactionsAndMessages()).flatMap((pending) => pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' ? [pending.transactionToSimulate.transaction] : [])
	assert.deepEqual(pendingTransactions.map((transaction) => transaction.nonce), [0n, 0n], 'both are formed from the same stack, so with the same nonce')
	const firstPreviewedHash = await getPreviewedHash(firstRequest.requestId)
	const secondPreviewedHash = await getPreviewedHash(secondRequest.requestId)
	assert.notEqual(firstPreviewedHash, secondPreviewedHash, 'each confirmation reserved its own hash when it was formed')

	const first = await acceptConfirmation(firstRequest, websiteTabConnections, postedMessages)
	const second = await acceptConfirmation(secondRequest, websiteTabConnections, postedMessages)
	assert.deepEqual([first.pageHash, second.pageHash], [firstPreviewedHash, secondPreviewedHash], 'each page gets the hash its preview showed')
	assert.deepEqual([first.stacked.signedTransaction.hash, second.stacked.signedTransaction.hash], [first.pageHash, second.pageHash], 'and it is the stored hash')
	assert.deepEqual(hashesOf(await assertEachStackedTransactionFoundByOwnHash()), [first.pageHash, second.pageHash])
})

test('keeps an import off the hash a pending confirmation reserved', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const previewedHash = await getPreviewedHash(request.requestId)
	const pending = (await modules.getPendingTransactionsAndMessages()).find((candidate) => candidate.uniqueRequestIdentifier.requestId === request.requestId)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
	// An imported transaction recorded under the reserved hash, as a stacked copy of the same transaction would be.
	const imported = { ...toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation), transactionIdentifier: 99n }
	assert.equal(imported.signedTransaction.hash, previewedHash)
	const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	const reply = await withSilencedConsole(async () => await importSimulationStack(simulator.ethereum, simulator.tokenPriceService, {
		method: 'popup_importSimulationStack',
		data: { name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1: await simulator.ethereum.ethSimulateV1Input([], 123n, undefined), interceptorSimulateStack: { operations: [asOperation(imported)] } },
	}))
	assert.equal(reply.ok, true)
	const [importedStacked] = await getStackedTransactions()
	assert.notEqual(importedStacked?.signedTransaction.hash, previewedHash, 'the import takes another hash')

	const accepted = await acceptConfirmation(request, websiteTabConnections, postedMessages)
	assert.equal(accepted.pageHash, previewedHash, 'the confirmation keeps its reserved hash')
	await assertEachStackedTransactionFoundByOwnHash()
})

test('fails accepting a confirmation, as a handled error, when its reserved hash was stacked by an update that ignored the reservation', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const previewedHash = await getPreviewedHash(request.requestId)
	if (previewedHash === undefined) throw new Error('Expected a previewed hash')
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation({ ...createStackedTransaction(99n, 7n), signedTransaction: { ...createStackedTransaction(99n, 7n).signedTransaction, hash: previewedHash } })] }))
	const stackBefore = await modules.getInterceptorTransactionStack()
	const resolved = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: request },
	}))
	assert.equal(resolved, false)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending?.approvalStatus.status, 'SignerError')
	assert.match(pending?.approvalStatus.status === 'SignerError' ? pending.approvalStatus.message : '', /Reject this request and send the transaction again/u)
	assert.deepEqual(await modules.getInterceptorTransactionStack(), stackBefore, 'nothing is stacked')
	assert.equal(postedMessages.some((message) => isRecord(message) && 'result' in message), false, 'the page gets no hash')
})

// Drops the reservations of the pending confirmations, as requests pending from before reservations have none.
const withoutReservations = async (requestIds: readonly number[]) => await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: (await modules.getPendingTransactionsAndMessages()).map((pending) => {
	if (pending.type !== 'Transaction' || !requestIds.includes(pending.uniqueRequestIdentifier.requestId)) return pending
	const { simulationHashReservation: _simulationHashReservation, ...withoutReservation } = pending
	return withoutReservation
}) })

test('accepts a confirmation pending from before reservations under its own hash', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withoutReservations([1])
	const accepted = await acceptConfirmation(request, websiteTabConnections, postedMessages)
	assert.equal(accepted.pageHash, accepted.stacked.signedTransaction.hash)
	assert.equal(accepted.pageHash, modules.mockSignTransaction(accepted.stacked.signedTransaction).hash, 'its mock-signed hash')
	await assertEachStackedTransactionFoundByOwnHash()
})

// Hashes the transaction's signed bytes, as a node would.
const hashOfSignedBytes = (transaction: PreSimulationTransaction) => BigInt(keccak256(serializeSignedTransactionToBytes(EthereumSignedTransactionToSignedTransaction(transaction.signedTransaction))))

for (const acceptOrder of [[1, 2], [2, 1]]) {
	test(`gives a confirmation pending from before reservations and an identical reserved one distinct previews and stacks both, accepted in order ${ acceptOrder.join(', ') }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const requests = [await openConfirmation(1, SENDER, 1n, websiteTabConnections)]
		await withoutReservations([1])
		requests.push(await openConfirmation(2, SENDER, 1n, websiteTabConnections))
		const previewedHashes = [await getPreviewedHash(1), await getPreviewedHash(2)]
		assert.notEqual(previewedHashes[0], previewedHashes[1], 'the reserved confirmation keeps off the hash the unreserved one would take')
		const accepted = []
		for (const requestId of acceptOrder) {
			const request = requests[requestId - 1]
			if (request === undefined) throw new Error('missing request')
			accepted.push(await acceptConfirmation(request, websiteTabConnections, postedMessages))
		}
		assert.equal(new Set(accepted.map(({ pageHash }) => pageHash)).size, 2)
		assert.deepEqual(accepted.map(({ pageHash }) => pageHash), acceptOrder.map((requestId) => previewedHashes[requestId - 1]), 'each page gets the hash its preview showed')
		await assertEachStackedTransactionFoundByOwnHash()
	})

	test(`reserves a hash for a confirmation whose transaction first forms on a refresh, apart from an identical later one, accepted in order ${ acceptOrder.join(', ') }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		fakeSafeContract.failEthSimulate = true
		const recovering = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [failed] = await modules.getPendingTransactionsAndMessages()
		if (failed?.type !== 'Transaction') throw new Error('Expected the pending transaction')
		assert.equal(failed.transactionOrMessageCreationStatus, 'FailedToSimulate')
		assert.equal(failed.simulationHashReservation, undefined, 'a confirmation that failed to form reserves nothing')
		fakeSafeContract.failEthSimulate = false
		await withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService))
		const [recovered] = await modules.getPendingTransactionsAndMessages()
		assert.notEqual(recovered?.type === 'Transaction' ? recovered.simulationHashReservation : undefined, undefined, 'the refresh that forms it reserves its hash')
		const later = await openConfirmation(2, SENDER, 1n, websiteTabConnections)
		const previewedHashes = [await getPreviewedHash(1), await getPreviewedHash(2)]
		assert.notEqual(previewedHashes[0], previewedHashes[1])
		const requests = [recovering, later]
		const accepted = []
		for (const requestId of acceptOrder) {
			const request = requests[requestId - 1]
			if (request === undefined) throw new Error('missing request')
			accepted.push(await acceptConfirmation(request, websiteTabConnections, postedMessages))
		}
		assert.deepEqual(accepted.map(({ pageHash }) => pageHash), acceptOrder.map((requestId) => previewedHashes[requestId - 1]), 'each page gets the hash its preview showed')
		await assertEachStackedTransactionFoundByOwnHash()
	})
}

test('signs colliding confirmations with their reserved salt, so the signed bytes hash to the reserved hash', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const firstRequest = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const secondRequest = await openConfirmation(2, SENDER, 1n, websiteTabConnections)
	const reservations = (await modules.getPendingTransactionsAndMessages()).map((pending) => pending.type === 'Transaction' ? pending.simulationHashReservation : undefined)
	assert.deepEqual(reservations.map((reservation) => reservation?.salt), [0n, 1n], 'the second collides and takes salt 1')
	const secondPending = (await modules.getPendingTransactionsAndMessages())[1]
	if (secondPending?.type !== 'Transaction' || secondPending.popupVisualisation === undefined || secondPending.popupVisualisation.statusCode !== 'success') throw new Error('Expected the previewed second confirmation')
	const previewed = secondPending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.transactions.at(-1)
	if (previewed === undefined) throw new Error('Expected the previewed transaction')
	assert.equal(getSalt(previewed), 1n, 'the preview is signed with the reserved salt')
	assert.equal(hashOfSignedBytes(previewed), reservations[1]?.hash)

	await acceptConfirmation(firstRequest, websiteTabConnections, postedMessages)
	const second = await acceptConfirmation(secondRequest, websiteTabConnections, postedMessages)
	assert.equal(getSalt(second.stacked), 1n, 'the stacked transaction keeps the reserved salt')
	assert.equal(hashOfSignedBytes(second.stacked), second.pageHash, 'its signed bytes hash to the hash the page got')
	assert.equal(second.pageHash, reservations[1]?.hash)
})

test('stores an import and a confirmation reserving at the same time under distinct hashes', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	// The transaction the confirmation forms, and the hash it reserves on an empty stack, which the import carries.
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [formed] = await modules.getPendingTransactionsAndMessages()
	if (formed?.type !== 'Transaction' || formed.transactionOrMessageCreationStatus !== 'Simulated' || formed.simulationHashReservation === undefined) throw new Error('Expected a reserved confirmation')
	const contestedHash = formed.simulationHashReservation.hash
	const imported = { ...toPreSimulationTransaction(formed.transactionToSimulate, formed.simulationHashReservation), transactionIdentifier: 99n }
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })

	// The import's read of the pending confirmations returns what storage held when it read, but only once released.
	let signalImportRead = () => undefined
	const importRead = new Promise<void>((resolve) => { signalImportRead = () => { resolve() } })
	let releaseImportRead = () => undefined
	const importReadReleased = new Promise<void>((resolve) => { releaseImportRead = () => { resolve() } })
	let deferNextPendingRead = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		const readsPending = keys === 'pendingTransactionsAndMessages' || (Array.isArray(keys) && keys.includes('pendingTransactionsAndMessages'))
		if (!readsPending || !deferNextPendingRead) return readStoredItems()
		deferNextPendingRead = false
		const items = readStoredItems()
		signalImportRead()
		await importReadReleased
		return items
	})
	const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	const importing = withSilencedConsole(async () => await importSimulationStack(simulator.ethereum, simulator.tokenPriceService, {
		method: 'popup_importSimulationStack',
		data: { name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1: await simulator.ethereum.ethSimulateV1Input([], 123n, undefined), interceptorSimulateStack: { operations: [asOperation(imported)] } },
	}))
	await importRead
	// The confirmation forms while the import waits on its read, and reaches its reservation.
	const simulationsBefore = fakeSafeContract.requestedRpcMethods.filter((method) => method === 'eth_simulateV1').length
	const confirming = openConfirmation(2, SENDER, 1n, websiteTabConnections)
	while (fakeSafeContract.requestedRpcMethods.filter((method) => method === 'eth_simulateV1').length === simulationsBefore) await new Promise((resolve) => setTimeout(resolve, 5))
	await new Promise((resolve) => setTimeout(resolve, 50))
	releaseImportRead()
	browserMock.setStorageGetHandler(undefined)
	assert.equal((await importing).ok, true)
	const request = await confirming

	const [importedStacked] = await getStackedTransactions()
	const accepted = await acceptConfirmation(request, websiteTabConnections, postedMessages)
	assert.notEqual(importedStacked?.signedTransaction.hash, accepted.pageHash)
	assert.ok([importedStacked?.signedTransaction.hash, accepted.pageHash].includes(contestedHash), 'one of them keeps the contested hash')
	await assertEachStackedTransactionFoundByOwnHash()
})

test('gives a re-imported transaction its own hash while the original is still stacked, keeping the original\'s', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const original = await acceptConfirmation(await openConfirmation(1, SENDER, 1n, websiteTabConnections), websiteTabConnections, postedMessages)
	const { requestInterceptorSimulationInput, importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	const simulationExport = await requestInterceptorSimulationInput(simulator.ethereum)
	if (!simulationExport.ok) throw new Error(simulationExport.message)
	const exported = InterceptorSimulationExport.parse(JSON.parse(simulationExport.ethSimulateV1InputString))
	const reply = await withSilencedConsole(async () => await importSimulationStack(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_importSimulationStack', data: exported }))
	assert.equal(reply.ok, true)

	const [stackedOriginal, reimported] = await assertEachStackedTransactionFoundByOwnHash()
	assert.equal(stackedOriginal?.signedTransaction.hash, original.pageHash, 'the original keeps the hash the page has')
	assert.notEqual(reimported?.signedTransaction.hash, original.pageHash)
	assert.equal(reimported?.signedTransaction.nonce, original.stacked.signedTransaction.nonce, 'the re-imported transaction keeps its recorded fields')
})

test('gives identical transactions within one import their own hashes', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const original = await acceptConfirmation(await openConfirmation(1, SENDER, 1n, websiteTabConnections), websiteTabConnections, postedMessages)
	const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	const operation = { type: 'Transaction' as const, preSimulationTransaction: original.stacked }
	const eth_simulateV1 = await simulator.ethereum.ethSimulateV1Input([], 123n, undefined)
	const reply = await withSilencedConsole(async () => await importSimulationStack(simulator.ethereum, simulator.tokenPriceService, {
		method: 'popup_importSimulationStack',
		data: { name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1, interceptorSimulateStack: { operations: [operation, operation] } },
	}))
	assert.equal(reply.ok, true)
	const [firstImported, secondImported] = await assertEachStackedTransactionFoundByOwnHash()
	assert.equal(firstImported?.signedTransaction.hash, original.pageHash, 'a free recorded hash is kept')
	assert.notEqual(secondImported?.signedTransaction.hash, original.pageHash)
})

test('keeps the Gnosis Safe execution marker of a transaction that needs a new hash, and the hash of one that does not', () => {
	const formed = {
		website: WEBSITE,
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: SENDER, to: RECIPIENT, value: 1n, input: new Uint8Array() }] },
		transactionIdentifier: 1n,
		success: true as const,
		transaction: { type: '1559' as const, from: SENDER, chainId: fakeRpcNetwork.chainId, nonce: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 21_000n, to: RECIPIENT, value: 1n, input: new Uint8Array(), accessList: [] },
		simulationOptions: { requiredChainId: fakeRpcNetwork.chainId, simulateWithZeroBaseFee: false, executeThroughSafe: true },
	}
	const safeExecution = { ...formed, signedTransaction: getSignedTransactionForSimulation(formed) }
	assert.equal(safeExecution.signedTransaction.s, 1n)
	assert.equal(withUniqueSimulationHash(safeExecution, new Set([0x1234n])), safeExecution, 'a transaction whose hash is free keeps it')

	const rehashed = withUniqueSimulationHash(safeExecution, new Set([safeExecution.signedTransaction.hash]))
	assert.notEqual(rehashed.signedTransaction.hash, safeExecution.signedTransaction.hash)
	assert.equal(rehashed.signedTransaction.s, 1n, 'the new mock signature still marks a Gnosis Safe execution')
	assert.equal(rehashed.signedTransaction.r, (1n << 160n) | SENDER, 'the salt sits above the sender in r')
	assert.deepEqual(rehashed.simulationOptions, safeExecution.simulationOptions)
	const { hash: _hash, r: _r, ...rehashedFields } = rehashed.signedTransaction
	const { hash: _originalHash, r: _originalR, ...originalFields } = safeExecution.signedTransaction
	assert.deepEqual(rehashedFields, originalFields, 'only the mock signature and hash change')
	assert.equal(withUniqueSimulationHash(safeExecution, new Set([safeExecution.signedTransaction.hash, rehashed.signedTransaction.hash])).signedTransaction.r, (2n << 160n) | SENDER, 'the lowest free salt is taken')
})

const asOperation = (preSimulationTransaction: PreSimulationTransaction) => ({ type: 'Transaction' as const, preSimulationTransaction })
const IMPORTED_SIGNATURE = { r: 0x1234n, s: 0x5678n, hash: 0xabcdefn }
const importedFields = { from: SENDER, chainId: fakeRpcNetwork.chainId, nonce: 0n, gas: 21_000n, to: RECIPIENT, value: 1n, input: new Uint8Array() }
const importedSignatureCases = [
	{ description: 'typed', signedTransaction: { ...importedFields, ...IMPORTED_SIGNATURE, type: '1559' as const, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], yParity: 'odd' as const, v: 1n } },
	{ description: 'legacy', signedTransaction: { ...importedFields, ...IMPORTED_SIGNATURE, type: 'legacy' as const, gasPrice: 0n, yParity: 'odd' as const, v: 28n } },
]

// A mock signature has even parity: v 0 on a legacy transaction, yParity even otherwise. Any v or yParity a representation carries must agree with it.
const assertMockParity = (fields: object, where: string) => {
	if ('v' in fields) assert.equal(fields.v, 0n, `${ where }: v`)
	if ('yParity' in fields) assert.equal(fields.yParity, 'even', `${ where }: yParity`)
}

for (const { description, signedTransaction } of importedSignatureCases) {
	test(`gives a re-hashed imported ${ description } transaction that carried v as well as yParity one consistent parity`, async () => {
		await startSimulationStack(SENDER)
		const operation = {
			type: 'Transaction' as const,
			preSimulationTransaction: {
				signedTransaction,
				website: WEBSITE,
				created: new Date('2024-01-01T00:00:00.000Z'),
				originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: SENDER, to: RECIPIENT, value: 1n, input: new Uint8Array() }] },
				transactionIdentifier: 1n,
			},
		}
		const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
		const eth_simulateV1 = await simulator.ethereum.ethSimulateV1Input([], 123n, undefined)
		const reply = await withSilencedConsole(async () => await importSimulationStack(simulator.ethereum, simulator.tokenPriceService, {
			method: 'popup_importSimulationStack',
			data: { name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1, interceptorSimulateStack: { operations: [operation, operation] } },
		}))
		assert.equal(reply.ok, true)
		const [kept, rehashed] = await getStackedTransactions()
		assert.equal(kept?.signedTransaction.hash, signedTransaction.hash, 'the first copy keeps its recorded hash')
		assert.ok(kept !== undefined && 'v' in kept.signedTransaction && kept.signedTransaction.v === signedTransaction.v, 'and its recorded signature')
		if (rehashed === undefined) throw new Error('Expected the re-hashed transaction')
		assert.equal(rehashed.signedTransaction.type, signedTransaction.type)
		assert.notEqual(rehashed.signedTransaction.hash, signedTransaction.hash)
		assert.equal(rehashed.signedTransaction.s, 0n)
		assert.equal('v' in rehashed.signedTransaction, signedTransaction.type === 'legacy', 'only a legacy transaction keeps a v, the mock one')
		assert.equal('yParity' in rehashed.signedTransaction, signedTransaction.type !== 'legacy', 'only a typed transaction keeps a yParity, the mock one')
		assertMockParity(rehashed.signedTransaction, 'stored')
		// Storing re-parses the stack, which drops a legacy yParity, so the re-signed transaction is also checked as appending forms it, unstored.
		const [appended] = appendOperationsToStack({ operations: [asOperation(kept)] }, [operation], new Set()).appended
		if (appended?.type !== 'Transaction') throw new Error('Expected the appended transaction')
		assert.equal(appended.preSimulationTransaction.signedTransaction.hash, rehashed.signedTransaction.hash, 'appending forms the stored transaction')
		assertMockParity(appended.preSimulationTransaction.signedTransaction, 'appended')

		const simulatedCalls: Record<string, unknown>[] = []
		const recordingEthereum = new modules.EthereumClientService({
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
				const simulationParams = rpcRequest.params?.[0]
				if (rpcRequest.method === 'eth_simulateV1' && isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls)) {
					for (const blockStateCall of simulationParams.blockStateCalls) simulatedCalls.push(...blockStateCall.calls)
				}
				return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			},
		}, async () => undefined, async () => undefined, fakeRpcNetwork)
		const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
		const input = await getCurrentSimulationInput()
		await createExecutionSimulationState(recordingEthereum, undefined, input)
		const rehashedCall = simulatedCalls.find((call) => call.r === rehashed.signedTransaction.r)
		if (rehashedCall === undefined) throw new Error('Expected the re-hashed transaction in the eth_simulateV1 request')
		assertMockParity(rehashedCall, 'eth_simulateV1 call')

		const lookedUp = await getSimulatedTransactionByHashFromInput(simulator.ethereum, undefined, toResolvedSimulationInput(input), rehashed.signedTransaction.hash)
		if (lookedUp === undefined) throw new Error('Expected the re-hashed transaction to be found by its hash')
		assertMockParity(lookedUp, 'lookup')
	})
}

// A stacked transaction that no confirmation or import formed, as any future source of stacked transactions would add it.
const createStackedTransaction = (transactionIdentifier: bigint, value: bigint): PreSimulationTransaction => ({
	signedTransaction: modules.mockSignTransaction({ type: '1559', from: SENDER, chainId: fakeRpcNetwork.chainId, nonce: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 21_000n, to: RECIPIENT, value, input: new Uint8Array(), accessList: [] }),
	website: WEBSITE,
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: SENDER, to: RECIPIENT, value, input: new Uint8Array() }] },
	transactionIdentifier,
})

test('appending transactions returns them with the hashes they are stored under, apart from the stack\'s and the reserved ones', async () => {
	await startSimulationStack(SENDER)
	const stacked = createStackedTransaction(1n, 1n)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stacked)] }))
	const reservedHash = modules.mockSignTransaction(createStackedTransaction(9n, 1n).signedTransaction, 0n, 1n).hash
	const { updateInterceptorTransactionStackWithResult } = await import('../../app/ts/background/storageVariables.js')
	const appended = await updateInterceptorTransactionStackWithResult((stack) => {
		const { stack: updatedStack, appended: [operation] } = appendOperationsToStack(stack, [asOperation(createStackedTransaction(2n, 1n))], new Set([reservedHash]))
		if (operation?.type !== 'Transaction') throw new Error('Expected the appended transaction')
		return { stack: updatedStack, result: operation.preSimulationTransaction }
	})
	assert.equal(getSalt(appended), 2n, 'salt 1 gives the reserved hash, so it is skipped')
	assert.deepEqual(hashesOf(await getStackedTransactions()), [stacked.signedTransaction.hash, appended.signedTransaction.hash])
})

test('rejects a stack update that adds a transaction under a stacked hash without appending it, whichever update function it goes through', async () => {
	await startSimulationStack(SENDER)
	const stacked = createStackedTransaction(1n, 1n)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stacked)] }))
	const bypassing = asOperation(createStackedTransaction(2n, 1n))
	await assert.rejects(modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, bypassing] })), /duplicated transaction hashes/u)
	const { updateTransactionState } = await import('../../app/ts/background/storageVariables.js')
	await assert.rejects(updateTransactionState((state) => ({ ...state, interceptorTransactionStack: { operations: [...state.interceptorTransactionStack.operations, bypassing] } })), /duplicated transaction hashes/u)
	assert.deepEqual(hashesOf(await getStackedTransactions()), [stacked.signedTransaction.hash], 'neither update is stored')
})

test('loads and updates a stack stored before #1713 that already holds a duplicate hash, keeping it, while appended transactions get their own', async () => {
	await startSimulationStack(SENDER)
	const original = createStackedTransaction(1n, 1n)
	const duplicate = { ...createStackedTransaction(2n, 1n), signedTransaction: original.signedTransaction }
	const { setLargeStateValue } = await import('../../app/ts/utils/largeStateStore.js')
	await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, { operations: [asOperation(original), asOperation(duplicate)] })
	assert.deepEqual(hashesOf(await getStackedTransactions()), [original.signedTransaction.hash, original.signedTransaction.hash], 'the stored stack loads as it is')

	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, { type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } }] }))
	assert.deepEqual(hashesOf(await getStackedTransactions()), [original.signedTransaction.hash, original.signedTransaction.hash], 'an update that adds no transaction keeps the duplicates')

	await modules.updateInterceptorTransactionStack((stack) => appendOperationsToStack(stack, [asOperation(createStackedTransaction(3n, 1n))], new Set()).stack)
	const [firstHash, secondHash, addedHash] = hashesOf(await getStackedTransactions())
	assert.deepEqual([firstHash, secondHash], [original.signedTransaction.hash, original.signedTransaction.hash], 'the stored duplicates keep the hashes pages have')
	assert.notEqual(addedHash, original.signedTransaction.hash, 'an appended transaction takes no hash already stacked')
})

test('leaves a Gnosis Safe proposal its safeTxHash even when that hash is already stacked', async () => {
	const safeTransaction = createSafeStackTransactionFixture({ transactionIdentifier: 2n })
	const proposal = { ...createStackedTransaction(2n, 1n), safeTransaction }
	const proposalWithSafeTxHash = { ...proposal, signedTransaction: { ...proposal.signedTransaction, hash: safeTransaction.safeTxHash } }
	assert.equal(withUniqueSimulationHash(proposalWithSafeTxHash, new Set([safeTransaction.safeTxHash])), proposalWithSafeTxHash)
})


test('stacks many identical transactions appended in one update with consecutive salts', async () => {
	await startSimulationStack(SENDER)
	await modules.updateInterceptorTransactionStack((stack) => appendOperationsToStack(stack, Array.from({ length: DUPLICATE_COUNT }, (_, index) => asOperation(createStackedTransaction(BigInt(index + 1), 1n))), new Set()).stack)
	const stackedTransactions = await getStackedTransactions()
	assert.equal(new Set(hashesOf(stackedTransactions)).size, DUPLICATE_COUNT)
	assert.deepEqual(stackedTransactions.map(getSalt), Array.from({ length: DUPLICATE_COUNT }, (_, index) => BigInt(index)))
})

test('signs each of many identical transactions a constant number of times when they share a salt search', () => {
	const takenHashes = new Set<bigint>()
	let candidateChecks = 0
	const isTaken = takenHashes.has.bind(takenHashes)
	takenHashes.has = (hash: bigint) => {
		candidateChecks++
		return isTaken(hash)
	}
	const saltSearch = createSaltSearch()
	const salts = Array.from({ length: DUPLICATE_COUNT }, (_, index) => {
		const unique = withUniqueSimulationHash(createStackedTransaction(BigInt(index + 1), 1n), takenHashes, saltSearch)
		takenHashes.add(unique.signedTransaction.hash)
		return getSalt(unique)
	})
	assert.deepEqual(salts, Array.from({ length: DUPLICATE_COUNT }, (_, index) => BigInt(index)))
	// One check of the transaction's own hash and one of the salt the search resumes at, instead of one per salt up to its own.
	assert.equal(candidateChecks, 2 * DUPLICATE_COUNT - 1)
})

const getReplyHashes = (postedMessages: readonly unknown[], requestId: number) => postedMessages.flatMap((message) => isRecord(message) && message.requestId === requestId && typeof message.result === 'string' ? [BigInt(message.result)] : [])

for (const reserved of [false, true]) {
	test(`stacks a confirmation accepted twice at once only once, under one hash, when it is ${ reserved ? 'reserved' : 'unreserved' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		if (!reserved) await withoutReservations([1])
		const accept = async () => await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
		const outcomes = await Promise.allSettled([accept(), accept()])
		assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'], 'no accept rejects')
		const stacked = await getStackedTransactions()
		assert.equal(stacked.length, 1, 'the transaction is stacked once')
		const replyHashes = getReplyHashes(postedMessages, request.requestId)
		assert.ok(replyHashes.length > 0, 'the page gets the hash')
		assert.deepEqual([...new Set(replyHashes)], [stacked[0]?.signedTransaction.hash], 'every reply carries the stacked hash')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	})
}

test('replies with the stacked hash again when an unreserved confirmation\'s accept is retried after it stacked the transaction', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withoutReservations([1])
	const [unreserved] = await modules.getPendingTransactionsAndMessages()
	if (unreserved === undefined) throw new Error('Expected the pending confirmation')
	const first = await acceptConfirmation(request, websiteTabConnections, postedMessages)
	// The request is pending again, as if the first accept stacked the transaction but stopped before resolving it.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [unreserved] })
	const retried = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	assert.notEqual(retried, false)
	assert.equal((await getStackedTransactions()).length, 1, 'the retry stacks nothing more')
	assert.deepEqual([...new Set(getReplyHashes(postedMessages, request.requestId))], [first.pageHash], 'the retry replies with the same hash')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('stops an accept whose request was resolved while it waited', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const { withSimulationHashLock } = await import('../../app/ts/background/simulationStackHashes.js')
	let releaseLock = () => undefined
	const lockReleased = new Promise<void>((resolve) => { releaseLock = () => { resolve() } })
	const holdingLock = withSimulationHashLock(async () => await lockReleased)
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	await new Promise((resolve) => setTimeout(resolve, 20))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	releaseLock()
	await holdingLock
	assert.equal(await accepting, false)
	assert.deepEqual(await getStackedTransactions(), [], 'nothing is stacked')
	assert.deepEqual(getReplyHashes(postedMessages, request.requestId), [])
})

// The page's terminal responses to a request: success hashes and error codes.
const getPageResponses = (postedMessages: readonly unknown[], requestId: number) => postedMessages.flatMap((message) => {
	if (!isRecord(message) || message.requestId !== requestId) return []
	if (typeof message.result === 'string') return [{ result: BigInt(message.result) }]
	if (isRecord(message.error) && typeof message.error.code === 'number') return [{ error: message.error.code }]
	return []
})

// Pauses the next stack read, which an unreserved request's acceptance makes while allocating its reservation, after it claimed the request.
const pauseNextStackRead = () => {
	let signalPaused = () => undefined
	const paused = new Promise<void>((resolve) => { signalPaused = () => { resolve() } })
	let release = () => undefined
	const released = new Promise<void>((resolve) => { release = () => { resolve() } })
	let armed = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!armed || !Array.isArray(keys) || !keys.includes('interceptorTransactionStack')) return readStoredItems()
		armed = false
		signalPaused()
		await released
		return readStoredItems()
	})
	return { paused, release: () => { browserMock.setStorageGetHandler(undefined); release() } }
}

for (const competitor of ['reject', 'popup close'] as const) {
	test(`lets an accept paused while it allocates win over a ${ competitor }, so the stack and the page agree`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		await withoutReservations([1])
		const pause = pauseNextStackRead()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
		await pause.paused
		try {
			const competing = competitor === 'reject'
				? await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))
				: await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			if (competitor === 'reject') assert.equal(competing, false, 'the reject loses to the claimed accept')
		} finally {
			pause.release()
			await accepting
		}
		const stacked = await getStackedTransactions()
		assert.equal(stacked.length, 1)
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }], 'the page gets only the accepted hash')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	})
}

test('stacks nothing for an accept that comes after a reject resolved the request', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))
	const accepted = await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	assert.notEqual(accepted, true)
	assert.deepEqual(await getStackedTransactions(), [])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the page gets only the rejection')
})

test('lets a reject that claimed the request first win over an accept that starts while it replies', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const resolve = (action: 'accept' | 'reject') => withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action, uniqueRequestIdentifier: request } }))
	const outcomes = await Promise.allSettled([resolve('reject'), resolve('accept')])
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
	assert.deepEqual(await getStackedTransactions(), [])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

// Pauses the next stack read and then fails it or lets it through, as chosen when released.
const pauseNextStackReadThen = () => {
	let signalPaused = () => undefined
	const paused = new Promise<void>((resolve) => { signalPaused = () => { resolve() } })
	let release: (fail: boolean) => void = () => undefined
	const released = new Promise<boolean>((resolve) => { release = resolve })
	let armed = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!armed || !Array.isArray(keys) || !keys.includes('interceptorTransactionStack')) return readStoredItems()
		armed = false
		signalPaused()
		if (await released) throw new Error('transient stack read failure')
		return readStoredItems()
	})
	return { paused, release: (fail: boolean) => { browserMock.setStorageGetHandler(undefined); release(fail) } }
}

const waitUntilNothingPending = async () => {
	const deadline = Date.now() + 2_000
	while ((await modules.getPendingTransactionsAndMessages()).length > 0) {
		if (Date.now() > deadline) throw new Error('The request stayed pending')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

for (const failure of ['throws before stacking', 'finds its hash taken', 'throws before stacking, and the deferred close fails looking the request up once'] as const) {
	test(`answers a popup close that lost to an accept once the accept ${ failure }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending?.type !== 'Transaction' || pending.simulationHashReservation === undefined) throw new Error('Expected a reserved confirmation')
		// A transaction stacked under the reserved hash by a write that ignored the reservation makes the accept find it taken.
		const acceptThrows = failure !== 'finds its hash taken'
		const stackBefore = failure === 'finds its hash taken'
			? { operations: [asOperation({ ...createStackedTransaction(99n, 7n), signedTransaction: { ...createStackedTransaction(99n, 7n).signedTransaction, hash: pending.simulationHashReservation.hash } })] }
			: { operations: [] }
		const { setLargeStateValue } = await import('../../app/ts/utils/largeStateStore.js')
		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, stackBefore)
		const pause = pauseNextStackReadThen()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
		await pause.paused
		try {
			await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the close waits for the claimed accept')
		} finally {
			pause.release(acceptThrows)
		}
		// After the failed accept, its claim release finishes the request again (one pending read), then looks the request up for the deferred close (the next), which fails once.
		let failedLookups = 0
		if (failure === 'throws before stacking, and the deferred close fails looking the request up once') {
			let pendingReads = 0
			browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
				if (!readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
				pendingReads += 1
				if (pendingReads !== 2) return readStoredItems()
				failedLookups += 1
				throw new Error('transient pending request read failure')
			})
		}
		const accepted = await accepting.then((result) => ({ result }), (error: unknown) => ({ error }))
		if (acceptThrows) assert.ok('error' in accepted, 'the accept fails')
		else assert.deepEqual(accepted, { result: false })
		await withSilencedConsole(async () => await waitUntilNothingPending())
		browserMock.setStorageGetHandler(undefined)
		if (failure === 'throws before stacking, and the deferred close fails looking the request up once') {
			assert.equal(failedLookups, 1, 'the deferred close\'s lookup failed')
			await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0))
			await assertNoResolutionBookkeeping()
		}
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the page gets exactly one rejection')
		assert.deepEqual(hashesOf(await getStackedTransactions()), hashesOf(stackBefore.operations.map((operation) => operation.preSimulationTransaction)), 'nothing new is stacked')
	})
}

// Pauses the next write of the pending requests, the removal that resolving a request makes, and then fails it once or lets it through, as chosen when released.
const pauseNextPendingWriteThen = () => {
	let signalPaused = () => undefined
	const paused = new Promise<void>((resolve) => { signalPaused = () => { resolve() } })
	let release: (fail: boolean) => void = () => undefined
	const released = new Promise<boolean>((resolve) => { release = resolve })
	let armed = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!armed || !('pendingTransactionsAndMessages' in items)) return writeStoredItems()
		armed = false
		signalPaused()
		if (await released) throw new Error('transient pending request write failure')
		writeStoredItems()
	})
	return { paused, release: (fail: boolean) => { release(fail) } }
}

// Fails the next write of the pending requests once.
const failNextPendingWrite = () => {
	let armed = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!armed || !('pendingTransactionsAndMessages' in items)) return writeStoredItems()
		armed = false
		throw new Error('transient pending request write failure')
	})
}

test('delivers the accepted hash, never a rejection, when the removal after stacking fails behind a popup close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextPendingWriteThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } })).then(() => undefined, () => undefined)
	await pause.paused
	try {
		assert.equal((await getStackedTransactions()).length, 1, 'the accept stacked the transaction before removing the request')
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	} finally {
		pause.release(true)
	}
	await accepting
	browserMock.setStorageSetHandler(undefined)
	await waitUntilNothingPending()
	const stacked = await getStackedTransactions()
	assert.equal(stacked.length, 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }], 'the page gets exactly the stacked hash')
})

test('rejects a request once when the removal after a deferred close\'s rejection fails and is retried', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } })).then(() => undefined, () => undefined)
	await pause.paused
	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		failNextPendingWrite()
	} finally {
		pause.release(true)
	}
	await withSilencedConsole(async () => {
		await accepting
		await waitUntilNothingPending()
	})
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the retry sends no second rejection')
	assert.deepEqual(await getStackedTransactions(), [])
})

test('rejects a request once when a reject\'s removal fails and a popup close follows', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	failNextPendingWrite()
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } })).then(() => undefined, () => undefined)
	browserMock.setStorageSetHandler(undefined)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the failed removal left the request pending')
	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

test('answers a popup close with the stacked hash when the request\'s transaction is already stacked but no reply was committed', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
	// As an accept leaves it that stacked the transaction and stopped before committing its reply, or one whose commitment a restart lost.
	const stackedTransaction = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stackedTransaction)] }))
	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stackedTransaction.signedTransaction.hash }])
})

const rejectRequest = async (request: Awaited<ReturnType<typeof openConfirmation>>, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } }))
const readsKey = (keys: unknown, key: string) => keys === key || (Array.isArray(keys) && keys.includes(key))

test('delivers a rejection once and closes the window when a read after removing the request fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let removed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) removed = true
	})
	let failedViewReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!removed || failedViewReads > 0 || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		failedViewReads += 1
		throw new Error('transient pending request read failure')
	})
	const closedWindows = await countingClosedWindows(async () => {
		await rejectRequest(request, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 200))
	})
	browserMock.setStorageSetHandler(undefined)
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failedViewReads, 1, 'a read after the removal failed')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the rejection is delivered once')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes')
	await assertNoResolutionBookkeeping()
})

test('retries closing the confirmation window when removing it fails, delivering the reply once', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removalAttempts: number[] = []
	windows.remove = async (windowId: number) => {
		removalAttempts.push(windowId)
		if (removalAttempts.length === 1) throw new Error('transient window removal failure')
		return await removeWindow(windowId)
	}
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForCondition(async () => removalAttempts.length === 2 && (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		windows.remove = removeWindow
	}
	assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the failed removal is retried')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the page settles once')
	await assertNoResolutionBookkeeping()
})

test('retries moving the confirmation window to the next request when that update fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await openConfirmation(2, SENDER, 2n, websiteTabConnections)
	// The view update reads the block number; it fails once after the first request is removed.
	let removed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 1) removed = true
	})
	const getBlockNumber = simulator.ethereum.getBlockNumber
	let failedViewUpdates = 0
	simulator.ethereum.getBlockNumber = async (...args: Parameters<typeof getBlockNumber>) => {
		if (removed && failedViewUpdates === 0) {
			failedViewUpdates += 1
			throw new Error('transient block number failure')
		}
		return await getBlockNumber.apply(simulator.ethereum, args)
	}
	browserMock.sentMessages.length = 0
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		simulator.ethereum.getBlockNumber = getBlockNumber
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal(failedViewUpdates, 1)
	assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'the window moves to the next request')
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2])
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

for (const flushFirst of [true, false]) {
	test(`closes the live window of a request whose reply was queued before windows were stored, at startup, flushing ${ flushFirst ? 'before' : 'after' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [pending] = await modules.getPendingTransactionsAndMessages()
		if (pending === undefined) throw new Error('Expected the pending request')
		const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
		await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier })
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
		const closedWindows = await countingClosedWindows(async () => {
			if (flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
			await withSilencedConsole(async () => await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			if (!flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		})
		assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the live window closes')
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
		await assertNoResolutionBookkeeping()
	})
}

test('closes the live window of a request whose reply was queued before windows were stored after a restart interrupts its cleanup', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier })
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
	// The first startup removes the request but cannot close the window, until its retries give up.
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	windows.remove = async () => { throw new Error('window removal unavailable') }
	try {
		await withSilencedConsole(async () => {
			await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await new Promise((resolve) => setTimeout(resolve, 2_000))
		})
	} finally {
		windows.remove = removeWindow
	}
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], 'the request was removed')
	assert.equal((await modules.getPendingTerminalReplies())[0]?.confirmationWindow?.id, CONFIRMATION_WINDOW_ID, 'its window is kept with the reply')
	await assertNoResolutionBookkeeping()

	beginStartupRecovery()
	const closedWindows = await countingClosedWindows(async () => await withSilencedConsole(async () => await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)))
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the next startup closes it')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	await assertNoResolutionBookkeeping()
})

test('delivers a rejection once when cleaning up the delivered reply\'s queue entry fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failQueueRead = false
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!failQueueRead || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failQueueRead = false
		throw new Error('transient terminal reply queue read failure')
	})
	// The page receives the reply, and the delivery then fails to remove it from the durable queue.
	const connection = websiteTabConnections.get(REQUEST_SOCKET.tabId)?.connections[modules.websiteSocketToString(REQUEST_SOCKET)]
	if (connection === undefined) throw new Error('missing connection')
	const port = connection.port
	connection.port = { ...port, postMessage(message: unknown) { port.postMessage(message); failQueueRead = true } }
	await rejectRequest(request, websiteTabConnections)
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageGetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the retry does not repost it')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('retries a popup close whose commitment write failed while the page was disconnected, and delivers it once the page reconnects', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedCommits = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failedCommits > 0 || !('pendingTerminalReplies' in items)) return writeStoredItems()
		failedCommits += 1
		throw new Error('transient terminal reply queue write failure')
	})
	await withSilencedConsole(async () => {
		await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, new Map())
		await waitUntilNothingPending()
	})
	browserMock.setStorageSetHandler(undefined)
	assert.equal(failedCommits, 1)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1, 'the retried commitment keeps the reply durably')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the reconnected page gets it once')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [], 'the delivered reply of a finished request is deleted')
})

test('stops retrying a resolution whose removal keeps failing while the page is disconnected, keeps its queued reply, and finishes it on a later close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedRemovals = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const pending = items.pendingTransactionsAndMessages
		if (!Array.isArray(pending) || pending.length > 0) return writeStoredItems()
		failedRemovals += 1
		throw new Error('persistent pending request removal failure')
	})
	await rejectRequest(request, new Map())
	await withSilencedConsole(async () => await new Promise((resolve) => setTimeout(resolve, 2_000)))
	const removalsWhenGivenUp = failedRemovals
	assert.equal(removalsWhenGivenUp, 6, 'the first attempt and five retries')
	await new Promise((resolve) => setTimeout(resolve, 500))
	assert.equal(failedRemovals, removalsWhenGivenUp, 'no more retries')
	browserMock.setStorageSetHandler(undefined)
	assert.equal((await modules.getPendingTerminalReplies()).length, 1, 'the undelivered reply stays queued')
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the committed request stays pending')

	await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the close finishes the committed rejection, once')
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

const waitForCondition = async (condition: () => Promise<boolean>) => {
	const deadline = Date.now() + 2_000
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the condition')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

test('delivers a reply once when its delivery throws before posting and a reconnect flush runs during the retry\'s backoff', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// The delivery's lookup of the page's connection throws once, before anything is posted.
	const getConnection = websiteTabConnections.get.bind(websiteTabConnections)
	let failNextLookup = false
	websiteTabConnections.get = (tabId: number) => {
		if (!failNextLookup) return getConnection(tabId)
		failNextLookup = false
		throw new Error('transient connection lookup failure')
	}
	// Armed when the rejection is committed, so the failing lookup is its delivery's.
	let committed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (!committed && 'pendingTerminalReplies' in items) {
			committed = true
			failNextLookup = true
		}
	})
	await rejectRequest(request, websiteTabConnections)
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [], 'the delivery failed before posting')
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the reconnect flush delivers it')
	await new Promise((resolve) => setTimeout(resolve, 300))
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'the scheduled retry does not deliver it again')
})

// Persists what an accept leaves when a restart interrupts it after enqueueing its reply and before removing the request: the stacked operation and the queued success reply, with nothing in memory. Then the restarted extension resolves the request, whose window is gone.
const recoverAfterRestart = async (requestId: number, operation: Parameters<typeof asOperation>[0] | { readonly type: 'Message', readonly signedMessageTransaction: unknown }, queuedResult: bigint | string | undefined, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => {
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, 'signedMessageTransaction' in operation ? operation : asOperation(operation)] }))
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	if (queuedResult !== undefined) {
		const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
		await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', result: queuedResult, uniqueRequestIdentifier: { requestId, requestSocket: REQUEST_SOCKET } })
	}
	browserMock.setLiveWindowIds([])
	await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
}

test('finishes an accepted transaction\'s queued reply on recovery after a restart, never rejecting it', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
	const stacked = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
	await recoverAfterRestart(1, stacked, stacked.signedTransaction.hash, websiteTabConnections)
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ result: stacked.signedTransaction.hash }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

const openMessageConfirmation = async (websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) => {
	const signRequest = (await import('../../app/ts/types/jsonRpc-signing-types.js')).PersonalSignParams.parse({ method: 'personal_sign', params: ['0x68656c6c6f', addressString(SENDER)] })
	const uniqueRequestIdentifier = { requestId: 1, requestSocket: REQUEST_SOCKET }
	const opened = await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, { interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...signRequest }, { kind: 'message', parameters: signRequest }, true, SENDER, WEBSITE, websiteTabConnections))
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated pending message, got ${ JSON.stringify(opened) }`)
	const { simulatePersonalSign } = await import('../../app/ts/simulation/services/simulationPersonalSigning.js')
	const signature = (await simulatePersonalSign(pending.originalRequestParameters, pending.signedMessageTransaction.fakeSignedFor)).signature
	return { operation: { type: 'Message' as const, signedMessageTransaction: pending.signedMessageTransaction }, signature }
}

for (const queued of [true, false]) {
	test(`answers an accepted message with its signature on recovery after a restart, never a rejection, when its reply ${ queued ? 'was queued' : 'was lost' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
		await recoverAfterRestart(1, operation, queued ? signature : undefined, websiteTabConnections)
		const responses = postedMessages.flatMap((message) => isRecord(message) && message.requestId === 1 && ('result' in message || 'error' in message) ? [isRecord(message.error) ? { error: message.error.code } : { result: message.result }] : [])
		assert.deepEqual(responses, [{ result: signature }])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	})
}

// Persists what a restart leaves after a resolution committed the pending request to a reply, before removing the request.
const seedCommittedReply = async (requestId: number, result: { readonly result: unknown } | { readonly error: { readonly code: number, readonly message: string } }) => {
	const pendingRequests = await modules.getPendingTransactionsAndMessages()
	const [pending] = pendingRequests
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', ...result, uniqueRequestIdentifier: { requestId, requestSocket: REQUEST_SOCKET }, confirmationWindow: pending.popupOrTabId })
}

const getAllPageResponses = (postedMessages: readonly unknown[], requestId: number) => postedMessages.flatMap((message) => isRecord(message) && message.requestId === requestId && ('result' in message || 'error' in message) ? [isRecord(message.error) ? { error: message.error.code } : { result: message.result }] : [])
const getStackedMessages = async () => (await modules.getInterceptorTransactionStack()).operations.filter((operation) => operation.type === 'Message')

for (const action of ['accept', 'reject', 'close'] as const) {
	test(`only finishes a committed message rejection that a reconnect flush delivered after a restart, on a later ${ action }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openMessageConfirmation(websiteTabConnections)
		await seedCommittedReply(1, { error: { code: 4001, message: 'User denied transaction signature' } })
		// The window is still open, so startup recovery leaves the request alone; the page reconnects and gets the queued rejection.
		await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
		await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }])
		const request = { requestId: 1, requestSocket: REQUEST_SOCKET }
		await withSilencedConsole(async () => action === 'close'
			? await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			: await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action, uniqueRequestIdentifier: request } }))
		await waitUntilNothingPending()
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }], 'no second reply')
		assert.deepEqual(await getStackedMessages(), [], 'the rejected message is not stacked')
	})
}

test('delivers a committed message signature once when a reconnect flush delivered it before recovery after a restart', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, operation] }))
	await seedCommittedReply(1, { result: signature })
	await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	browserMock.setLiveWindowIds([])
	await withSilencedConsole(async () => await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	await waitUntilNothingPending()
	assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ result: signature }])
	assert.equal((await getStackedMessages()).length, 1)
})

test('stacks a message an earlier accept already stacked only once when accepted again', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const { operation, signature } = await openMessageConfirmation(websiteTabConnections)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, operation] }))
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: { requestId: 1, requestSocket: REQUEST_SOCKET } } }))
	assert.equal((await getStackedMessages()).length, 1)
	assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ result: signature }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

// The states an accepted transaction's resolution leaves when the extension restarts at each persistence boundary, from committing its reply to deleting it.
const restartStates = [
	{ boundary: 'the commitment write', entry: 'none', pending: true, windowPending: false },
	{ boundary: 'the delivery', entry: 'undelivered', pending: true, windowPending: true },
	{ boundary: 'the pending request removal', entry: 'delivered', pending: true, windowPending: true },
	{ boundary: 'the window update', entry: 'delivered', pending: false, windowPending: true },
	{ boundary: 'the entry delete', entry: 'delivered', pending: false, windowPending: false },
] as const

// Counts the confirmation windows closed while running.
const countingClosedWindows = async (run: () => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removedWindows: number[] = []
	windows.remove = async (windowId: number) => { removedWindows.push(windowId); return await removeWindow(windowId) }
	try {
		await run()
	} finally {
		windows.remove = removeWindow
	}
	return removedWindows
}

for (const state of restartStates) {
	for (const windowSurvived of [false, true]) {
		for (const flushFirst of [true, false]) {
			test(`finishes an accepted transaction once with its stacked hash after a restart at ${ state.boundary }, ${ windowSurvived ? 'with its window open' : 'with its window gone' }, flushing ${ flushFirst ? 'before' : 'after' } startup`, async () => {
				await startSimulationStack(SENDER)
				const postedMessages: unknown[] = []
				const websiteTabConnections = createWebsiteTabConnections(postedMessages)
				await openConfirmation(1, SENDER, 1n, websiteTabConnections)
				const [pending] = await modules.getPendingTransactionsAndMessages()
				if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a simulated pending transaction')
				const stacked = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
				await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stacked)] }))
				const { commitPendingTerminalReply, markPendingTerminalReplyDelivered } = await import('../../app/ts/background/pendingTerminalReplies.js')
				if (state.entry !== 'none') await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', result: stacked.signedTransaction.hash, uniqueRequestIdentifier: pending.uniqueRequestIdentifier, ...(state.windowPending ? { confirmationWindow: pending.popupOrTabId } : {}) })
				if (state.entry === 'delivered') await markPendingTerminalReplyDelivered(pending.uniqueRequestIdentifier)
				if (!state.pending) await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
				// A delivered entry's reply reached the page before the restart.
				const expectedNewReplies = state.entry === 'delivered' ? [] : [{ result: modules.EthereumBytes32.serialize(stacked.signedTransaction.hash) }]

				browserMock.setLiveWindowIds(windowSurvived ? [CONFIRMATION_WINDOW_ID] : [])
				const { resumeCommittedRequests, getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
				const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
				const startUp = async () => await withSilencedConsole(async () => {
					await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
					await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
				})
				const closedWindows = await countingClosedWindows(async () => {
					if (flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
					await startUp()
					if (!flushFirst) await modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
				})
				if (state.entry === 'none' && windowSurvived) {
					// An uncommitted request whose window survived waits for the user, whose accept answers with the stacked hash.
					assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
					assert.deepEqual(getAllPageResponses(postedMessages, 1), [])
					await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: { requestId: 1, requestSocket: REQUEST_SOCKET } } }))
				}
				assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [], 'the request completes')
				assert.deepEqual(getAllPageResponses(postedMessages, 1), expectedNewReplies, 'exactly the original reply, once')
				assert.deepEqual(await modules.getPendingTerminalReplies(), [], 'the finished request leaves no entry')
				assert.deepEqual(hashesOf(await getStackedTransactions()), [stacked.signedTransaction.hash], 'the stack keeps the accepted transaction')
				if (windowSurvived && state.entry !== 'none' && state.windowPending) assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window that showed the last request closes')
				assert.equal(getResolutionBookkeepingSize() + getTerminalReplyBookkeepingSize(), 0, 'no bookkeeping is left')
			})
		}
	}
}

test('posts a reply once when storing its delivered mark fails, and deletes it once its request is finished', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let queueWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (!('pendingTerminalReplies' in items)) return writeStoredItems()
		queueWrites += 1
		// The first write commits the reply; the second, its delivered mark, fails once.
		if (queueWrites === 2) throw new Error('transient delivered mark failure')
		writeStoredItems()
	})
	await rejectRequest(request, websiteTabConnections)
	await withSilencedConsole(async () => await waitUntilNothingPending())
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
})

test('deletes a finished request\'s delivered reply when the first delete fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failDelete = true
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failDelete && Array.isArray(items.pendingTerminalReplies) && items.pendingTerminalReplies.length === 0) {
			failDelete = false
			throw new Error('transient entry delete failure')
		}
		writeStoredItems()
	})
	const closedWindows = await countingClosedWindows(async () => {
		await rejectRequest(request, websiteTabConnections)
		await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0))
	})
	browserMock.setStorageSetHandler(undefined)
	assert.equal(failDelete, false, 'the first delete failed')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(closedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes once')
	await assertNoResolutionBookkeeping()
})

const assertNoResolutionBookkeeping = async () => {
	const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	assert.equal(getResolutionBookkeepingSize() + getTerminalReplyBookkeepingSize(), 0, 'no bookkeeping is left')
}

// Collects the unhandled promise rejections while running.
const collectingUnhandledRejections = async (run: () => Promise<void>) => {
	const rejections: unknown[] = []
	const onUnhandledRejection = (reason: unknown) => { rejections.push(reason) }
	process.on('unhandledRejection', onUnhandledRejection)
	try {
		await run()
		await new Promise((resolve) => setTimeout(resolve, 20))
	} finally {
		process.off('unhandledRejection', onUnhandledRejection)
	}
	return rejections
}

const scheduledRetryFailures = [
	{ step: 'its committed reply lookup', fails: (kind: 'get' | 'set', items: unknown) => kind === 'get' && readsKey(items, 'pendingTerminalReplies') },
	{ step: 'its pending request lookup', fails: (kind: 'get' | 'set', items: unknown) => kind === 'get' && readsKey(items, 'pendingTransactionsAndMessages') },
	{ step: 'deleting its delivered reply', fails: (kind: 'get' | 'set', items: unknown) => kind === 'set' && isRecord(items) && Array.isArray(items.pendingTerminalReplies) && items.pendingTerminalReplies.length === 0 },
] as const

for (const { step, fails } of scheduledRetryFailures) {
	test(`completes a request whose scheduled finishing retry fails at ${ step }, without an unhandled rejection`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		// The first attempt fails removing the request, which schedules a retry; that retry then fails once at the step.
		let removalFailed = false
		let retryFailed = false
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if (!removalFailed && Array.isArray(items.pendingTransactionsAndMessages) && items.pendingTransactionsAndMessages.length === 0) {
				removalFailed = true
				throw new Error('transient pending request removal failure')
			}
			if (removalFailed && !retryFailed && fails('set', items)) {
				retryFailed = true
				throw new Error('transient failure during the scheduled retry')
			}
			writeStoredItems()
		})
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (removalFailed && !retryFailed && fails('get', keys)) {
				retryFailed = true
				throw new Error('transient failure during the scheduled retry')
			}
			return readStoredItems()
		})
		const unhandledRejections = await collectingUnhandledRejections(async () => await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			// Wait without reading storage until the scheduled retry has failed, so only the retry meets the failure.
			const deadline = Date.now() + 2_000
			while (!retryFailed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		}))
		browserMock.setStorageSetHandler(undefined)
		browserMock.setStorageGetHandler(undefined)
		assert.deepEqual([removalFailed, retryFailed], [true, true], 'both failures happened')
		assert.deepEqual(unhandledRejections, [])
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await assertNoResolutionBookkeeping()
	})
}

test('retries an explicit reject whose commitment write failed, keeping the rejection', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedCommits = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if (failedCommits > 0 || !('pendingTerminalReplies' in items)) return writeStoredItems()
		failedCommits += 1
		throw new Error('transient terminal reply queue write failure')
	})
	await rejectRequest(request, websiteTabConnections)
	assert.equal(failedCommits, 1)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the request waits for the retried commitment')
	// An accept meanwhile does not change the chosen outcome.
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	await withSilencedConsole(async () => await waitUntilNothingPending())
	browserMock.setStorageSetHandler(undefined)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.deepEqual(await getStackedTransactions(), [], 'nothing is stacked')
	await assertNoResolutionBookkeeping()
})

for (const requestCount of [1, 2]) {
	test(`${ requestCount === 1 ? 'closes the confirmation window' : 'moves the confirmation window to the next request' } when a committed request it shows is finished from storage alone`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		if (requestCount === 2) await openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await seedCommittedReply(1, { error: { code: 4001, message: 'User denied transaction signature' } })
		const windows = Reflect.get(globalThis, 'browser').windows
		const removeWindow = windows.remove
		const removedWindows: number[] = []
		windows.remove = async (windowId: number) => { removedWindows.push(windowId); return await removeWindow(windowId) }
		browserMock.sentMessages.length = 0
		try {
			await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: { requestId: 1, requestSocket: REQUEST_SOCKET } } }))
		} finally {
			windows.remove = removeWindow
		}
		assert.deepEqual(getAllPageResponses(postedMessages, 1), [{ error: 4001 }], 'the committed rejection, not the accept')
		assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), requestCount === 1 ? [] : [2])
		if (requestCount === 1) assert.deepEqual(removedWindows, [CONFIRMATION_WINDOW_ID], 'the window closes after its last request')
		else {
			assert.deepEqual(removedWindows, [], 'the window stays open')
			assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'and moves to the next request')
		}
	})
}

test('leaves no delivery bookkeeping behind when a reconnect flush delivers a reply before its resolution looks it up', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	const bookkeepingBefore = getTerminalReplyBookkeepingSize()
	// The flush runs as soon as the reply is committed, before the resolution delivers it.
	let flushed = false
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		writeStoredItems()
		if (flushed || !('pendingTerminalReplies' in items)) return
		flushed = true
		void modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
	})
	await rejectRequest(request, websiteTabConnections)
	await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	browserMock.setStorageSetHandler(undefined)
	assert.equal(flushed, true)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	assert.equal(getTerminalReplyBookkeepingSize(), bookkeepingBefore)
})

// Fails the first confirmation window removal while running, then lets removals through.
const failingFirstWindowRemoval = async (run: () => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const removeWindow = windows.remove
	const removalAttempts: number[] = []
	windows.remove = async (windowId: number) => {
		removalAttempts.push(windowId)
		if (removalAttempts.length === 1) throw new Error('transient window removal failure')
		return await removeWindow(windowId)
	}
	try {
		await run()
	} finally {
		windows.remove = removeWindow
	}
	return removalAttempts
}

const seedCommittedRejection = async (options: { readonly delivered: boolean, readonly withWindow: boolean }) => {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending === undefined) throw new Error('Expected the pending request')
	const { commitPendingTerminalReply, markPendingTerminalReplyDelivered } = await import('../../app/ts/background/pendingTerminalReplies.js')
	await commitPendingTerminalReply({ ...pending.originalRequestParameters, type: 'result', error: { code: 4001, message: 'User denied transaction signature' }, uniqueRequestIdentifier: pending.uniqueRequestIdentifier, ...(options.withWindow ? { confirmationWindow: pending.popupOrTabId } : {}) })
	if (options.delivered) await markPendingTerminalReplyDelivered(pending.uniqueRequestIdentifier)
}

for (const trigger of ['startup', 'the requesting tab closing'] as const) {
	test(`finishes a committed request whose requesting tab is gone on ${ trigger }, closing its window despite a failed first close`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		await seedCommittedRejection({ delivered: false, withWindow: true })
		browserMock.setLiveTabIds([])
		const confirmTransaction = await import('../../app/ts/background/windows/confirmTransaction.js')
		const removalAttempts = await failingFirstWindowRemoval(async () => await withSilencedConsole(async () => {
			if (trigger === 'startup') await confirmTransaction.resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, new Map())
			else await confirmTransaction.finishCommittedRequestsOfTab(REQUEST_SOCKET.tabId, simulator.ethereum, simulator.tokenPriceService, new Map())
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		}))
		assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the window closes on the retry')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(getPageResponses(postedMessages, 1), [], 'the gone tab gets nothing')
		await assertNoResolutionBookkeeping()
	})
}

test('finishes a request once when a reconnect flush overlaps its finishing, closing its window despite a failed first close', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// A reply queued before windows were stored, not yet delivered.
	await seedCommittedRejection({ delivered: false, withWindow: false })
	// The flush's read of the queue is held while the finishing starts; storing the window takes the same lock as the flush, so it waits for the flush instead of racing it.
	let signalFlushRead = () => undefined
	const flushRead = new Promise<void>((resolve) => { signalFlushRead = () => { resolve() } })
	let releaseFlushRead = () => undefined
	const flushReadReleased = new Promise<void>((resolve) => { releaseFlushRead = () => { resolve() } })
	let holdNextQueueRead = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!holdNextQueueRead || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		holdNextQueueRead = false
		signalFlushRead()
		await flushReadReleased
		return readStoredItems()
	})
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
	const removalAttempts = await failingFirstWindowRemoval(async () => await withSilencedConsole(async () => {
		const flushing = modules.flushPendingTerminalRepliesForSocket(websiteTabConnections, REQUEST_SOCKET)
		await flushRead
		browserMock.setStorageGetHandler(undefined)
		const finishing = resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 20))
		releaseFlushRead()
		await Promise.all([flushing, finishing])
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	}))
	assert.deepEqual(removalAttempts, [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID], 'the window closes on the retry')
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the page settles once')
	await assertNoResolutionBookkeeping()
})

for (const closeDeferred of [false, true]) {
	test(`finishes a request again when its requesting tab closes after the finishing checked it, retiring the undeliverable reply${ closeDeferred ? ', also after a popup close deferred before the commitment' : '' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const confirmTransaction = await import('../../app/ts/background/windows/confirmTransaction.js')
		// A popup close arriving while the reject holds the claim, before its reply is committed, is deferred.
		let closesDeferred = 0
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if (closeDeferred && closesDeferred === 0 && 'pendingTerminalReplies' in items) {
				closesDeferred += 1
				await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, new Map())
			}
			writeStoredItems()
		})
		// The page is disconnected, so the rejection stays undelivered; the tab closes while the finishing closes the window, after it found the tab open.
		const windows = Reflect.get(globalThis, 'browser').windows
		const removeWindow = windows.remove
		let tabClosings = 0
		windows.remove = async (windowId: number) => {
			if (tabClosings === 0) {
				tabClosings += 1
				browserMock.setLiveTabIds([])
				await confirmTransaction.finishCommittedRequestsOfTab(REQUEST_SOCKET.tabId, simulator.ethereum, simulator.tokenPriceService, new Map())
			}
			return await removeWindow(windowId)
		}
		try {
			await withSilencedConsole(async () => {
				await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: request } })
				await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
			})
		} finally {
			windows.remove = removeWindow
			browserMock.setStorageSetHandler(undefined)
		}
		assert.deepEqual([tabClosings, closesDeferred], [1, closeDeferred ? 1 : 0])
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [], 'the closed tab gets no reply')
		await assertNoResolutionBookkeeping()
	})
}


test('retries listing a closed tab\'s committed replies when the first listing fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await seedCommittedRejection({ delivered: false, withWindow: true })
	browserMock.setLiveTabIds([])
	let failedListings = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failedListings > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedListings += 1
		throw new Error('transient terminal reply queue read failure')
	})
	const { finishCommittedRequestsOfTab } = await import('../../app/ts/background/windows/confirmTransaction.js')
	await withSilencedConsole(async () => {
		await finishCommittedRequestsOfTab(REQUEST_SOCKET.tabId, simulator.ethereum, simulator.tokenPriceService, new Map())
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failedListings, 1)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [])
	await assertNoResolutionBookkeeping()
})

// Windows open, close and exist as the browser would, with hooks to pause or fail their creation and removal.
const withBrowserWindows = async (hooks: { readonly beforeCreate?: (attempt: number) => Promise<void>, readonly beforeRemove?: (windowId: number) => Promise<void> }, run: (state: { readonly liveWindows: () => readonly number[], readonly createdWindows: () => readonly number[] }) => Promise<void>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const { create: createWindow, remove: removeWindow } = windows
	let liveWindows = [CONFIRMATION_WINDOW_ID]
	const createdWindows: number[] = []
	let createAttempts = 0
	windows.create = async () => {
		createAttempts += 1
		await hooks.beforeCreate?.(createAttempts)
		const windowId = CONFIRMATION_WINDOW_ID + 1 + createdWindows.length
		createdWindows.push(windowId)
		liveWindows = [...liveWindows, windowId]
		browserMock.setLiveWindowIds(liveWindows)
		return { id: windowId }
	}
	windows.remove = async (windowId: number) => {
		await hooks.beforeRemove?.(windowId)
		liveWindows = liveWindows.filter((id) => id !== windowId)
		browserMock.setLiveWindowIds(liveWindows)
	}
	try {
		await run({ liveWindows: () => liveWindows, createdWindows: () => createdWindows })
	} finally {
		windows.create = createWindow
		windows.remove = removeWindow
	}
}

const createGate = () => {
	let signalReached = () => undefined
	const reached = new Promise<void>((resolve) => { signalReached = () => { resolve() } })
	let open = () => undefined
	const opened = new Promise<void>((resolve) => { open = () => { resolve() } })
	return { reached, open, pass: async () => { signalReached(); await opened } }
}

// Pauses the second confirmation's hash reservation, after it picked its window and before it registers.
const pausingRegistrationAfterWindowPick = (gate: ReturnType<typeof createGate>) => {
	const windows = Reflect.get(globalThis, 'browser').windows
	const getWindow = windows.get
	let pickedWindow = false
	windows.get = async (windowId: number) => {
		const window = await getWindow(windowId)
		pickedWindow = true
		return window
	}
	let armed = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!pickedWindow || !armed || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
		armed = false
		await gate.pass()
		return readStoredItems()
	})
	return () => {
		windows.get = getWindow
		browserMock.setStorageGetHandler(undefined)
	}
}



test('moves the window to a confirmation that registers in it before the window\'s last other request is resolved', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const registration = createGate()
	await withBrowserWindows({}, async ({ liveWindows, createdWindows }) => {
		const restore = pausingRegistrationAfterWindowPick(registration)
		try {
			// The second confirmation picks the open window and pauses before registering, holding the pending-confirmation lock.
			const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await registration.reached
			// Rejecting the first request decides about the window only once the second registered.
			const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the window is not closed while the second registers')
			browserMock.sentMessages.length = 0
			registration.open()
			await Promise.all([opening, rejecting])
		} finally {
			restore()
		}
		assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the window stays open')
		assert.deepEqual(createdWindows(), [], 'no other window opens')
	})
	const [second] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: CONFIRMATION_WINDOW_ID }, 'the second request is in the open window')
	assert.ok(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog'), 'and the window moves to it')
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(getPageResponses(postedMessages, 2), [])
	await assertNoResolutionBookkeeping()
})

test('opens a new window for a confirmation that chooses its window while the window\'s last request is closing it', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windowClose = createGate()
	await withBrowserWindows({ beforeRemove: async () => await windowClose.pass() }, async ({ liveWindows, createdWindows }) => {
		// Rejecting the first request closes its window, holding the pending-confirmation lock.
		const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
		await windowClose.reached
		// The second confirmation chooses its window only once the close is done.
		const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await new Promise((resolve) => setTimeout(resolve, 50))
		windowClose.open()
		await Promise.all([rejecting, opening])
		assert.equal(createdWindows().length, 1, 'one new window opens')
		assert.deepEqual(liveWindows(), createdWindows(), 'only the new window is open')
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] }, 'the second request is in the new window')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(getPageResponses(postedMessages, 2), [])
	await assertNoResolutionBookkeeping()
})

test('rejects a request once when the user closes a window whose programmatic close failed, opening no new window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await withBrowserWindows({ beforeRemove: async () => { throw new Error('transient window removal failure') } }, async ({ createdWindows }) => {
		// Rejecting the request fails to close its window; the finishing retries.
		await rejectRequest(first, websiteTabConnections)
		// The user closes the window before the retry.
		browserMock.setLiveWindowIds([])
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		assert.deepEqual(createdWindows(), [], 'no new window opens')
	})
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the request is rejected once')
	await assertNoResolutionBookkeeping()
})

test('runs a popup close deferred behind an orphan rejection in the claim holder\'s context, so registration under the pending-confirmation lock completes', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const orphan = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const orphanStackRead = createGate()
	await withBrowserWindows({}, async ({ createdWindows }) => {
		// The orphan's window is gone, so the next registration rejects it under the pending-confirmation lock.
		browserMock.setLiveWindowIds([])
		const windows = Reflect.get(globalThis, 'browser').windows
		const getWindow = windows.get
		let choosingWindow = false
		windows.get = async (windowId: number) => {
			choosingWindow = true
			return await getWindow(windowId)
		}
		// The orphan's rejection reads the stack after claiming it; that read is held, then fails once.
		let armed = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!choosingWindow || !armed || !readsKey(keys, 'interceptorTransactionStack')) return readStoredItems()
			armed = false
			await orphanStackRead.pass()
			throw new Error('transient stack read failure')
		})
		try {
			const registering = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await orphanStackRead.reached
			// A close event for the orphan's window arrives meanwhile and is deferred behind the claim.
			await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
			orphanStackRead.open()
			await withSilencedConsole(async () => await registering)
		} finally {
			windows.get = getWindow
			browserMock.setStorageGetHandler(undefined)
		}
		await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== orphan.requestId)))
		// A later registration completes too.
		await openConfirmation(3, SENDER, 3n, websiteTabConnections)
		assert.equal(createdWindows().length, 1, 'one window opened for the new requests')
	})
	assert.deepEqual((await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId), [2, 3])
	assert.deepEqual(getPageResponses(postedMessages, orphan.requestId), [{ error: 4001 }], 'the orphan is rejected once')
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
		return getResolutionBookkeepingSize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

test('closes a resolved request\'s window when the next request, choosing its window while holding the lock, already sees the request removed and opens its own', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const windowChoice = createGate()
	await withBrowserWindows({}, async ({ liveWindows, createdWindows }) => {
		// The next request's window choice reads the pending requests under the pending-confirmation lock; that read is held, and returns what is stored once released.
		let armed = true
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!armed || !readsKey(keys, 'pendingTransactionsAndMessages')) return readStoredItems()
			armed = false
			await windowChoice.pass()
			return readStoredItems()
		})
		try {
			const opening = openConfirmation(2, SENDER, 2n, websiteTabConnections)
			await windowChoice.reached
			// The first request is rejected and removed; its window cleanup waits for the lock.
			const rejecting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'reject', uniqueRequestIdentifier: first } }))
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).length === 0)
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.deepEqual(liveWindows(), [CONFIRMATION_WINDOW_ID], 'the cleanup waits for the lock')
			windowChoice.open()
			await Promise.all([opening, rejecting])
		} finally {
			browserMock.setStorageGetHandler(undefined)
		}
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.equal(createdWindows().length, 1)
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] }, 'the second request is in its own window')
		assert.deepEqual(liveWindows(), createdWindows(), 'the first request\'s window, without requests, closed')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

test('closes a resolved request\'s window on the retry of a failed close after the next request opened its own window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let removals = 0
	await withBrowserWindows({
		beforeRemove: async () => {
			removals += 1
			if (removals === 1) throw new Error('transient window removal failure')
		},
	}, async ({ liveWindows, createdWindows }) => {
		await rejectRequest(first, websiteTabConnections)
		// The next request sees no pending request and opens its own window before the retry.
		await openConfirmation(2, SENDER, 2n, websiteTabConnections)
		await withSilencedConsole(async () => await waitForCondition(async () => !liveWindows().includes(CONFIRMATION_WINDOW_ID)))
		const [second] = await modules.getPendingTransactionsAndMessages()
		assert.equal(createdWindows().length, 1)
		assert.deepEqual(second?.popupOrTabId, { type: 'popup', id: createdWindows()[0] })
		assert.deepEqual(liveWindows(), createdWindows(), 'exactly the second request\'s window is open')
	})
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

// Fails the given read of the committed replies, counted from now, once.
const failingCommittedReplyRead = (failingRead: number) => {
	let reads = 0
	let failed = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		reads += 1
		if (reads !== failingRead) return readStoredItems()
		failed += 1
		throw new Error('transient committed reply read failure')
	})
	return () => failed
}

test('rejects a request once when its window closes and the finishing first fails to look up its committed reply', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	browserMock.setLiveWindowIds([])
	// The close checks for a committed reply (the first read), then its finishing looks it up again (the second), which fails.
	const failures = failingCommittedReplyRead(2)
	await withSilencedConsole(async () => {
		await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failures(), 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
		return getResolutionBookkeepingSize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

test('rejects a request once when a close deferred behind a failed accept first fails to look up its committed reply', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	await pause.paused
	try {
		await withSilencedConsole(async () => await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections))
	} finally {
		pause.release(true)
	}
	// After the failed accept, its claim release finishes it again (the first read), then the deferred close checks for a committed reply (the second) and finishes (the third), which fails.
	const failures = failingCommittedReplyRead(3)
	await accepting.then(() => undefined, () => undefined)
	await withSilencedConsole(async () => {
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failures(), 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await withSilencedConsole(async () => await waitForCondition(async () => {
		const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
		return getResolutionBookkeepingSize() === 0
	}))
	await assertNoResolutionBookkeeping()
})

const waitForNoResolutionBookkeeping = async () => await withSilencedConsole(async () => await waitForCondition(async () => {
	const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	return getResolutionBookkeepingSize() + getTerminalReplyBookkeepingSize() === 0
}))

for (const lookup of ['its committed reply', 'the stack'] as const) {
	test(`rejects a request once when a reject first fails to look up ${ lookup }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		let failed = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failed > 0 || !readsKey(keys, lookup === 'the stack' ? 'interceptorTransactionStack' : 'pendingTerminalReplies')) return readStoredItems()
			failed += 1
			throw new Error('transient read failure')
		})
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		browserMock.setStorageGetHandler(undefined)
		assert.equal(failed, 1)
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await waitForNoResolutionBookkeeping()
	})
}

test('rejects a request that is still simulating once when the reject\'s finishing fails first', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: (await modules.getPendingTransactionsAndMessages()).map((pending) => pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' ? { ...pending, transactionOrMessageCreationStatus: 'Simulating' as const, transactionToSimulate: pending.transactionToSimulate } : pending) })
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus, 'Simulating')
	let failed = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failed > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failed += 1
		throw new Error('transient read failure')
	})
	await withSilencedConsole(async () => {
		await rejectRequest(request, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	browserMock.setStorageGetHandler(undefined)
	assert.equal(failed, 1)
	const responses = getPageResponses(postedMessages, request.requestId)
	assert.equal(responses.length, 1, 'one settlement')
	assert.ok(responses.every((response) => 'error' in response), 'a rejection')
	await waitForNoResolutionBookkeeping()
})

for (const acceptOutcome of ['succeeds', 'fails'] as const) {
	test(`settles a request once when a reject competes with an accept that ${ acceptOutcome }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const pause = pauseNextStackReadThen()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
		await pause.paused
		try {
			// The reject finds the request claimed by the accept, so its decline waits for the accept.
			assert.equal(await rejectRequest(request, websiteTabConnections), false)
		} finally {
			pause.release(acceptOutcome === 'fails')
		}
		await accepting.then(() => undefined, () => undefined)
		await withSilencedConsole(async () => {
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		const responses = getPageResponses(postedMessages, request.requestId)
		const stacked = await getStackedTransactions()
		if (acceptOutcome === 'succeeds') {
			assert.equal(stacked.length, 1)
			assert.deepEqual(responses, [{ result: stacked[0]?.signedTransaction.hash }], 'exactly the accepted hash')
		} else {
			assert.deepEqual(stacked, [])
			assert.deepEqual(responses, [{ error: 4001 }], 'exactly one rejection')
		}
		await waitForNoResolutionBookkeeping()
	})
}

const waitForNoResolutionBookkeepingWhileFailing = async () => {
	const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const deadline = Date.now() + 10_000
	while (getResolutionBookkeepingSize() > 0) {
		if (Date.now() > deadline) throw new Error('The retries did not stop')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

test('stops retrying a close whose lookups keep failing at the limit, leaving no retry bookkeeping', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedLookups = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedLookups += 1
		throw new Error('persistent read failure')
	})
	try {
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: CONFIRMATION_WINDOW_ID }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			// The decline and the finishing it starts each retry at most five times, with backoff from 50 ms to 800 ms.
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const lookupsAtLimit = failedLookups
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(failedLookups, lookupsAtLimit, 'the retries stopped')
		assert.ok(lookupsAtLimit > 1, 'it retried')
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
})

test('stops a reject\'s retries at one budget when every committed-reply read is slow and fails', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		await new Promise((resolve) => setTimeout(resolve, 120))
		failedReads += 1
		throw new Error('slow persistent read failure')
	})
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const readsWhenExhausted = failedReads
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		assert.equal(failedReads, readsWhenExhausted, 'nothing retries after the budget is spent')
		assert.ok(readsWhenExhausted <= 6, `one budget of attempts (${ readsWhenExhausted } reads)`)
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	// The reject was stored with the request before its failing lookups, so startup with the window open finishes it.
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.declineRequested, 'reject')
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
	await withSilencedConsole(async () => {
		await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

test('finishes a reject whose retries ran out before committing at startup, while its window is still open', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// Every write of a committed reply fails, so the reject runs out of retries before committing.
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('pendingTerminalReplies' in items) throw new Error('persistent reply write failure')
		writeStoredItems()
	})
	try {
		await withSilencedConsole(async () => {
			await rejectRequest(request, websiteTabConnections)
			await waitForNoResolutionBookkeepingWhileFailing()
		})
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
	const [pending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pending?.declineRequested, 'reject', 'the reject is stored with the request')
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
	// After a restart with the window open, startup finishes it.
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
	await withSilencedConsole(async () => {
		await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		await waitUntilNothingPending()
		await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
	})
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
	await assertNoResolutionBookkeeping()
})

for (const closedWindow of [CONFIRMATION_WINDOW_ID, CONFIRMATION_WINDOW_ID + 1]) {
	test(`declines only the requests of the closed window ${ closedWindow === CONFIRMATION_WINDOW_ID ? 'holding an orphan awaiting its retry' : 'of a later request' }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		const [orphan] = await modules.getPendingTransactionsAndMessages()
		if (orphan === undefined) throw new Error('Expected the pending request')
		// A later request shown in its own window.
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [orphan, { ...orphan, uniqueRequestIdentifier: { requestId: 2, requestSocket: REQUEST_SOCKET }, transactionIdentifier: 2n, popupOrTabId: { type: 'popup', id: CONFIRMATION_WINDOW_ID + 1 } }] })
		browserMock.setLiveWindowIds([CONFIRMATION_WINDOW_ID + 1])
		// The orphan's decline fails once and waits for its retry.
		let failedReads = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (failedReads > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
			failedReads += 1
			throw new Error('transient read failure')
		})
		await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'noResponse', uniqueRequestIdentifier: orphan.uniqueRequestIdentifier } }))
		browserMock.setStorageGetHandler(undefined)
		assert.equal(failedReads, 1)
		await withSilencedConsole(async () => {
			await modules.onCloseWindowOrTab({ type: 'popup', id: closedWindow }, simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			// The orphan's retry declines it in any case; the later request only if its window closed.
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== 1))
			await new Promise((resolve) => setTimeout(resolve, 200))
		})
		const remaining = (await modules.getPendingTransactionsAndMessages()).map((pending) => pending.uniqueRequestIdentifier.requestId)
		assert.deepEqual(remaining, closedWindow === CONFIRMATION_WINDOW_ID ? [2] : [], 'only the closed window\'s requests, and the orphan, are declined')
		assert.equal(getPageResponses(postedMessages, 1).length, 1, 'the orphan settles once')
		assert.deepEqual(getPageResponses(postedMessages, 2), closedWindow === CONFIRMATION_WINDOW_ID ? [] : [{ error: 4001 }])
	})
}

test('stops the startup recovery composition when its committed-reply reads keep failing, with an orphan pending', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	browserMock.setLiveWindowIds([])
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('persistent read failure')
	})
	const { createRetriableTerminalStateRecovery } = await import('../../app/ts/background/terminalStateRecovery.js')
	const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
	const recoveryFailures: boolean[] = []
	// As the background composes it at startup.
	const recover = createRetriableTerminalStateRecovery({
		recover: async () => {
			await modules.resolvePendingRequestsForMissingConfirmationWindows(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
		},
		onFailure: (_error, retrying) => { recoveryFailures.push(retrying) },
	})
	try {
		await withSilencedConsole(async () => {
			await recover()
			const deadline = Date.now() + 8_000
			while (recoveryFailures.at(-1) !== false && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
			await waitForNoResolutionBookkeepingWhileFailing()
		})
		const readsWhenStopped = failedReads
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(recoveryFailures.at(-1), false, 'the recovery gave up')
		assert.ok(recoveryFailures.length <= 6, 'within its attempt limit')
		assert.equal(failedReads, readsWhenStopped, 'nothing retries afterwards')
		await assertNoResolutionBookkeeping()
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
})

test('rejects only the requests whose own window is gone when another confirmation opens, reusing a live window', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const [orphan] = await modules.getPendingTransactionsAndMessages()
	if (orphan === undefined) throw new Error('Expected the pending request')
	const LIVE_WINDOW_ID = CONFIRMATION_WINDOW_ID + 1
	// The first request's window is gone; the second request is shown in a live window.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [orphan, { ...orphan, uniqueRequestIdentifier: { requestId: 2, requestSocket: REQUEST_SOCKET }, transactionIdentifier: 2n, popupOrTabId: { type: 'popup', id: LIVE_WINDOW_ID } }] })
	browserMock.setLiveWindowIds([LIVE_WINDOW_ID])
	await withSilencedConsole(async () => await openConfirmation(3, SENDER, 3n, websiteTabConnections))
	await withSilencedConsole(async () => await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages()).every((pending) => pending.uniqueRequestIdentifier.requestId !== 1)))
	const remaining = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(remaining.map((pending) => pending.uniqueRequestIdentifier.requestId), [2, 3], 'the live window\'s request stays pending')
	assert.deepEqual(remaining.map((pending) => pending.popupOrTabId.id), [LIVE_WINDOW_ID, LIVE_WINDOW_ID], 'the new request reuses the live window')
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }], 'the orphan is rejected')
	assert.deepEqual(getPageResponses(postedMessages, 2), [], 'the live request is not')
})

for (const acceptStackedBeforeRestart of [false, true]) {
	test(`stores a reject that competes with an accept, so startup after a restart ${ acceptStackedBeforeRestart ? 'answers with the hash the accept stacked' : 'rejects the request' }`, async () => {
		await startSimulationStack(SENDER)
		const firstSessionMessages: unknown[] = []
		const firstSessionConnections = createWebsiteTabConnections(firstSessionMessages)
		const request = await openConfirmation(1, SENDER, 1n, firstSessionConnections)
		const pause = pauseNextStackReadThen()
		const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, firstSessionConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
		await pause.paused
		let storedPending: Awaited<ReturnType<typeof modules.getPendingTransactionsAndMessages>>
		try {
			assert.equal(await rejectRequest(request, firstSessionConnections), false, 'the reject waits for the accept')
			await waitForCondition(async () => (await modules.getPendingTransactionsAndMessages())[0]?.declineRequested === 'reject')
			// The state a restart here leaves: the reject stored with the request, no reply committed.
			storedPending = await modules.getPendingTransactionsAndMessages()
		} finally {
			pause.release(true)
		}
		await accepting.then(() => undefined, () => undefined)
		await withSilencedConsole(async () => await waitUntilNothingPending())

		// The restarted extension starts from that stored state.
		const [pending] = storedPending
		if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the stored pending transaction')
		const stackedByAccept = toPreSimulationTransaction(pending.transactionToSimulate, pending.simulationHashReservation)
		await modules.updateInterceptorTransactionStack(() => ({ operations: acceptStackedBeforeRestart ? [asOperation(stackedByAccept)] : [] }))
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: storedPending })
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
	beginStartupRecovery()
		await withSilencedConsole(async () => {
			await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		const stacked = await getStackedTransactions()
		if (acceptStackedBeforeRestart) {
			assert.deepEqual(hashesOf(stacked), [stackedByAccept.signedTransaction.hash])
			assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stackedByAccept.signedTransaction.hash }], 'the stacked hash, once')
		} else {
			assert.deepEqual(stacked, [], 'nothing is stacked')
			assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'one rejection')
		}
		await assertNoResolutionBookkeeping()
	})
}

test('stops retrying a connected port\'s reply flush when storage keeps failing, and recovers when the port reconnects', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	await seedCommittedRejection({ delivered: false, withWindow: false })
	// The request was finished but its reply not delivered, so a reconnect flush delivers it.
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('persistent read failure')
	})
	const port = websiteTabConnections.get(REQUEST_SOCKET.tabId)?.connections[modules.websiteSocketToString(REQUEST_SOCKET)]?.port
	if (port === undefined) throw new Error('missing port')
	const { getTerminalReplyBookkeepingSize } = await import('../../app/ts/background/terminalReplyDelivery.js')
	try {
		await withSilencedConsole(async () => {
			await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, REQUEST_SOCKET, port)
			const deadline = Date.now() + 8_000
			while (getTerminalReplyBookkeepingSize() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
		})
		const readsWhenStopped = failedReads
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		assert.equal(failedReads, readsWhenStopped, 'the retries stopped')
		assert.ok(readsWhenStopped <= 6, `within the budget (${ readsWhenStopped } reads)`)
		assert.equal(getTerminalReplyBookkeepingSize(), 0, 'no retry timer remains')
	} finally {
		browserMock.setStorageGetHandler(undefined)
	}
	assert.deepEqual(getPageResponses(postedMessages, 1), [])
	// The port reconnects once storage works again.
	await modules.flushPendingTerminalRepliesForConnectedPortWithRetry(websiteTabConnections, REQUEST_SOCKET, port)
	assert.deepEqual(getPageResponses(postedMessages, 1), [{ error: 4001 }])
	assert.deepEqual(await modules.getPendingTerminalReplies(), [])
})

test('counts concurrent failures of one request against its one retry budget, with one timer that parks on the claim, and cancels it on completion', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const pause = pauseNextStackReadThen()
	const accepting = withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier: request } }))
	await pause.paused
	// Every write storing the reject on the request fails, as their reports are written slowly.
	let failedIntentWrites = 0
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		const pending = items.pendingTransactionsAndMessages
		if (Array.isArray(pending) && pending.some((entry) => isRecord(entry) && entry.declineRequested !== undefined)) {
			failedIntentWrites += 1
			throw new Error('persistent intent write failure')
		}
		if ('interceptorErrorDiagnostics' in items) await new Promise((resolve) => setTimeout(resolve, 30))
		writeStoredItems()
	})
	const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
	try {
		await withSilencedConsole(async () => {
			// Two rejects at once, each deferred behind the accept's claim with a failing intent write.
			await Promise.all([rejectRequest(request, websiteTabConnections), rejectRequest(request, websiteTabConnections)])
			await waitForCondition(async () => failedIntentWrites >= 2)
			await new Promise((resolve) => setTimeout(resolve, 40))
			// The accept's claim and its deferred decline, with at most one retry timer, which parks on the claim when it comes due.
			assert.ok(getResolutionBookkeepingSize() <= 3, 'at most one retry timer')
			await new Promise((resolve) => setTimeout(resolve, 500))
			assert.equal(getResolutionBookkeepingSize(), 2, 'the retry is parked, not polling')
		})
		assert.equal(failedIntentWrites, 2, 'each failure counted once, and no attempts while the request is claimed')
	} finally {
		browserMock.setStorageSetHandler(undefined)
		pause.release(false)
	}
	// The accept completes, and the request's retries are all gone.
	await accepting
	await withSilencedConsole(async () => await waitUntilNothingPending())
	const stacked = await getStackedTransactions()
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ result: stacked[0]?.signedTransaction.hash }])
	await waitForNoResolutionBookkeeping()
})

for (const recovery of ['a new reject', 'startup'] as const) {
	test(`spends one budget on a reject whose committed-reply reads keep failing while failure reports are slow, then recovers on ${ recovery }`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
		let failedReads = 0
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (!readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
			failedReads += 1
			throw new Error('persistent read failure')
		})
		// Reporting a failure takes long, so retries come due while the request's claim is still held.
		browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
			if ('interceptorErrorDiagnostics' in items) await new Promise((resolve) => setTimeout(resolve, 1_800))
			writeStoredItems()
		})
		const { getResolutionBookkeepingSize } = await import('../../app/ts/background/windows/confirmTransaction.js')
		try {
			await withSilencedConsole(async () => {
				await rejectRequest(request, websiteTabConnections)
				// Settled once no resolution is in flight or scheduled for a while.
				let quietSince = Date.now()
				const deadline = Date.now() + 40_000
				while (Date.now() - quietSince < 2_500 && Date.now() < deadline) {
					if (getResolutionBookkeepingSize() > 0) quietSince = Date.now()
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			})
			const readsWhenSettled = failedReads
			await new Promise((resolve) => setTimeout(resolve, 1_000))
			assert.equal(failedReads, readsWhenSettled, 'no later attempts')
			assert.ok(readsWhenSettled <= 6, `at most one budget of attempts (${ readsWhenSettled } reads)`)
		} finally {
			browserMock.setStorageGetHandler(undefined)
			browserMock.setStorageSetHandler(undefined)
		}
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [])
		await withSilencedConsole(async () => {
			if (recovery === 'a new reject') await rejectRequest(request, websiteTabConnections)
			else {
				const { beginStartupRecovery, resumeCommittedRequests } = await import('../../app/ts/background/windows/confirmTransaction.js')
				beginStartupRecovery()
				await resumeCommittedRequests(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections)
			}
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
		assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }])
		await waitForNoResolutionBookkeeping()
	}, 90_000)
}

test('parks a retry that comes due while the request is claimed, without polling, and runs it once the claim is released', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const request = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	// The reject's first committed-reply read fails, and reporting that failure is held, so its retry comes due while the reject still holds the claim.
	let failedReads = 0
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (failedReads > 0 || !readsKey(keys, 'pendingTerminalReplies')) return readStoredItems()
		failedReads += 1
		throw new Error('transient read failure')
	})
	const report = createGate()
	browserMock.setStorageSetHandler(async (items, writeStoredItems) => {
		if ('interceptorErrorDiagnostics' in items) await report.pass()
		writeStoredItems()
	})
	// Counts the timers scheduled while the report is held.
	const realSetTimeout = globalThis.setTimeout
	let schedules = 0
	const countingSetTimeout = (...args: Parameters<typeof setTimeout>) => {
		schedules += 1
		return realSetTimeout(...args)
	}
	try {
		const rejecting = withSilencedConsole(async () => await rejectRequest(request, websiteTabConnections))
		await report.reached
		// The retry comes due within 50 ms and parks.
		await new Promise((resolve) => realSetTimeout(resolve, 100))
		globalThis.setTimeout = Object.assign(countingSetTimeout, realSetTimeout)
		await new Promise((resolve) => realSetTimeout(resolve, 1_000))
		globalThis.setTimeout = realSetTimeout
		assert.equal(schedules, 0, 'nothing is scheduled while the claim is held')
		report.open()
		await rejecting
		await withSilencedConsole(async () => {
			await waitUntilNothingPending()
			await waitForCondition(async () => (await modules.getPendingTerminalReplies()).length === 0)
		})
	} finally {
		globalThis.setTimeout = realSetTimeout
		browserMock.setStorageGetHandler(undefined)
		browserMock.setStorageSetHandler(undefined)
	}
	assert.equal(failedReads, 1)
	assert.deepEqual(getPageResponses(postedMessages, request.requestId), [{ error: 4001 }], 'one settlement')
	await waitForNoResolutionBookkeeping()
})

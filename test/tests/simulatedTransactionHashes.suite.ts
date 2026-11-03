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

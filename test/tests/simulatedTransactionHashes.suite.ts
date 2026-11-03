import * as assert from 'assert'
import { test } from 'bun:test'
import { InterceptorSimulationExport, InterceptorTransactionStack, type PreSimulationTransaction, toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
import { createExecutionSimulationState, getSimulatedTransactionByHashFromInput, getSimulatedTransactionReceipt } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createSaltSearch, getSignedTransactionForSimulation, withUniqueSimulationHash } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { asAppendedToStack } from '../../app/ts/background/simulationStackHashes.js'
import { addressString, browserMock, createSafeStackTransactionFixture, createWebsitePort, fakeRequestHandler, fakeRpcNetwork, isRecord, modules, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'

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

test('gives the second of two identical confirmations that were pending at once its own hash when both are accepted', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const firstRequest = await openConfirmation(1, SENDER, 1n, websiteTabConnections)
	const secondRequest = await openConfirmation(2, SENDER, 1n, websiteTabConnections)
	const pendingTransactions = (await modules.getPendingTransactionsAndMessages()).flatMap((pending) => pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' ? [pending.transactionToSimulate.transaction] : [])
	assert.deepEqual(pendingTransactions.map((transaction) => transaction.nonce), [0n, 0n], 'both are formed from the same stack, so with the same nonce')

	const first = await acceptConfirmation(firstRequest, websiteTabConnections, postedMessages)
	const second = await acceptConfirmation(secondRequest, websiteTabConnections, postedMessages)
	assert.equal(first.stacked.signedTransaction.hash, first.pageHash)
	assert.equal(second.stacked.signedTransaction.hash, second.pageHash, 'the page gets the hash the transaction was stacked with')
	assert.notEqual(first.pageHash, second.pageHash)
	assert.deepEqual(hashesOf(await assertEachStackedTransactionFoundByOwnHash()), [first.pageHash, second.pageHash], 'the first accepted transaction keeps its hash')
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
		// Storing re-parses the stack, which drops a legacy yParity; the preview uses the transaction as normalized, unstored.
		const keptOperation = asOperation(kept)
		const previewed = asAppendedToStack({ operations: [keptOperation] }, operation.preSimulationTransaction)
		assert.equal(previewed.signedTransaction.hash, rehashed.signedTransaction.hash, 'the preview shows the stored hash')
		assertMockParity(previewed.signedTransaction, 'previewed')

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
		const input = await getCurrentSimulationInput(undefined, undefined, { operations: [keptOperation, asOperation(previewed)] })
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

test('gives a transaction that any stack update adds a hash of its own, whichever update function adds it', async () => {
	await startSimulationStack(SENDER)
	const stacked = createStackedTransaction(1n, 1n)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [asOperation(stacked)] }))
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, asOperation(createStackedTransaction(2n, 1n))] }))
	const { updateTransactionState } = await import('../../app/ts/background/storageVariables.js')
	await updateTransactionState((state) => ({ ...state, interceptorTransactionStack: { operations: [...state.interceptorTransactionStack.operations, asOperation(createStackedTransaction(3n, 1n))] } }))
	const hashes = hashesOf(await getStackedTransactions())
	assert.equal(hashes[0], stacked.signedTransaction.hash, 'the first keeps its hash')
	assert.equal(new Set(hashes).size, 3)
})

test('loads and updates a stack stored before #1713 that already holds a duplicate hash, keeping it, while new transactions get their own', async () => {
	await startSimulationStack(SENDER)
	const original = createStackedTransaction(1n, 1n)
	const duplicate = { ...createStackedTransaction(2n, 1n), signedTransaction: original.signedTransaction }
	const { setLargeStateValue } = await import('../../app/ts/utils/largeStateStore.js')
	await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, { operations: [asOperation(original), asOperation(duplicate)] })
	assert.deepEqual(hashesOf(await getStackedTransactions()), [original.signedTransaction.hash, original.signedTransaction.hash], 'the stored stack loads as it is')

	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, { type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } }] }))
	assert.deepEqual(hashesOf(await getStackedTransactions()), [original.signedTransaction.hash, original.signedTransaction.hash], 'an update that adds no transaction keeps the duplicates')

	const added = createStackedTransaction(3n, 1n)
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, asOperation(added)] }))
	const [firstHash, secondHash, addedHash] = hashesOf(await getStackedTransactions())
	assert.deepEqual([firstHash, secondHash], [original.signedTransaction.hash, original.signedTransaction.hash], 'the stored duplicates keep the hashes pages have')
	assert.notEqual(addedHash, original.signedTransaction.hash, 'a new transaction takes no hash already stacked')
})

test('leaves a Gnosis Safe proposal its safeTxHash even when that hash is already stacked', async () => {
	const safeTransaction = createSafeStackTransactionFixture({ transactionIdentifier: 2n })
	const proposal = { ...createStackedTransaction(2n, 1n), safeTransaction }
	const proposalWithSafeTxHash = { ...proposal, signedTransaction: { ...proposal.signedTransaction, hash: safeTransaction.safeTxHash } }
	assert.equal(withUniqueSimulationHash(proposalWithSafeTxHash, new Set([safeTransaction.safeTxHash])), proposalWithSafeTxHash)
})

const DUPLICATE_COUNT = 200
const getSalt = (transaction: PreSimulationTransaction) => transaction.signedTransaction.r >> 160n

test('stacks many identical transactions added in one update with consecutive salts', async () => {
	await startSimulationStack(SENDER)
	await modules.updateInterceptorTransactionStack(() => ({ operations: Array.from({ length: DUPLICATE_COUNT }, (_, index) => asOperation(createStackedTransaction(BigInt(index + 1), 1n))) }))
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

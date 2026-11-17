import * as assert from 'assert'
import { test } from 'bun:test'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'
import { browserMock, createReplayableAcceptConfirmation, modules, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { REQUEST_SOCKET, SENDER, WEBSITE, createTransferParams, acceptConfirmation, createWebsiteTabConnections, getPageResponses, getStackedTransactions, openConfirmation, startSimulationStack } from './simulationConfirmationTestHarness.js'



for (const requestId of [-7, 7]) {
	test(`a reject of a request reusing request id ${ requestId } gets a rejection, not the success of the accepted request before it`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const first = await openConfirmation(requestId, SENDER, 1n, websiteTabConnections)
		const accepted = await acceptConfirmation(first, websiteTabConnections, postedMessages)
		const second = await openConfirmation(requestId, SENDER, 2n, websiteTabConnections)
		await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: second },
		}))
		assert.deepEqual(getPageResponses(postedMessages, requestId), [{ result: accepted.pageHash }, { error: METAMASK_ERROR_USER_REJECTED_REQUEST }])
		assert.deepEqual((await getStackedTransactions()).map((transaction) => transaction.signedTransaction.hash), [accepted.stacked.signedTransaction.hash], 'the accepted transaction is untouched')
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
		assert.deepEqual(await modules.getPendingTerminalReplies(), [])
	})

	test(`an accept of a request reusing request id ${ requestId } stacks its own transaction`, async () => {
		await startSimulationStack(SENDER)
		const postedMessages: unknown[] = []
		const websiteTabConnections = createWebsiteTabConnections(postedMessages)
		const first = await openConfirmation(requestId, SENDER, 1n, websiteTabConnections)
		await acceptConfirmation(first, websiteTabConnections, postedMessages)
		const second = await openConfirmation(requestId, SENDER, 2n, websiteTabConnections)
		await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(second)))
		const stacked = await getStackedTransactions()
		assert.equal(stacked.length, 2)
		assert.deepEqual(getPageResponses(postedMessages, requestId), stacked.map((transaction) => ({ result: transaction.signedTransaction.hash })))
	})
}

test('a request reusing the id of a pending request gets no second confirmation, and the pending request answers the id once', async () => {
	await startSimulationStack(SENDER)
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const first = await openConfirmation(-7, SENDER, 1n, websiteTabConnections)
	await openConfirmation(-7, SENDER, 2n, websiteTabConnections)
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	const accepted = await acceptConfirmation(first, websiteTabConnections, postedMessages)
	assert.deepEqual(getPageResponses(postedMessages, -7), [{ result: accepted.pageHash }])
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

for (const kind of ['transaction', 'message'] as const) {
	const open = async (websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>, activeAddress: bigint | undefined) => {
		const uniqueRequestIdentifier = { requestId: 93, requestSocket: REQUEST_SOCKET }
		const parameters = await createTransferParams(1n)
		const request = { interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, method: parameters.method, params: parameters.params }
		return await withSilencedConsole(async () => kind === 'transaction'
			? await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'transaction', parameters }, true, activeAddress, WEBSITE, websiteTabConnections)
			: await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: { method: 'personal_sign', params: ['0x68656c6c6f', SENDER] } }, true, activeAddress, WEBSITE, websiteTabConnections))
	}

	test(`an already pending ${ kind } bypasses preparation and window recovery`, async () => {
		await startSimulationStack(SENDER)
		const connections = createWebsiteTabConnections([])
		assert.deepEqual(await open(connections, SENDER), { type: 'doNotReply' })
		const pending = await modules.getPendingTransactionsAndMessages()
		browserMock.setLiveWindowIds([])
		browserMock.setWindowCreateHandler(async () => { throw new Error('A duplicate must not open a window') })
		// A changed or missing active address must not turn a duplicate into a new preparation failure.
		assert.deepEqual(await open(connections, undefined), { type: 'doNotReply' })
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), pending)
	})

	test(`a failed ${ kind } preparation releases admission for a later retry`, async () => {
		await startSimulationStack(SENDER)
		const connections = createWebsiteTabConnections([])
		assert.equal((await open(connections, undefined)).type, 'result')
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
		assert.deepEqual(await open(connections, SENDER), { type: 'doNotReply' })
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	})

	test(`concurrent ${ kind } openings share one admission before creating a window`, async () => {
		await startSimulationStack(SENDER)
		let windowsCreated = 0
		browserMock.setWindowCreateHandler(async () => { windowsCreated++ })
		const connections = createWebsiteTabConnections([])
		assert.deepEqual(await Promise.all([open(connections, SENDER), open(connections, SENDER)]), [{ type: 'doNotReply' }, { type: 'doNotReply' }])
		assert.equal(windowsCreated, 1)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	})
}

import * as assert from 'assert'
import { test } from 'bun:test'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'
import { createReplayableAcceptConfirmation, modules, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { SENDER, acceptConfirmation, createWebsiteTabConnections, getPageResponses, getStackedTransactions, openConfirmation, startSimulationStack } from './simulationConfirmationTestHarness.js'



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

import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, createWebsitePort, fakeRequestHandler, modules, recipientAddress, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'

const transactionParams = SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{
		from: addressString(activeAddress),
		to: addressString(recipientAddress),
		value: '0x0',
		gas: '0x5208',
		maxFeePerGas: '0x1',
		maxPriorityFeePerGas: '0x1',
		data: '0x',
	}],
})

function createWebsiteTabConnections() {
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	return new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
}

async function openTransactionConfirmation() {
	return await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
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
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		createWebsiteTabConnections(),
	))
}

const isConfirmationStored = () => {
	const stored = browserMock.storageState.pendingTransactionsAndMessages
	return Array.isArray(stored) && stored.length > 0
}

test('a confirmation whose simulation throws before it starts is removed and its window closed when the website gets the rejection', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	// Once the confirmation is stored, the simulation's own tab state read is the first to fail, before the simulation's try.
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (keys === `tabState_${ uniqueRequestIdentifier.requestSocket.tabId }` && isConfirmationStored()) throw new Error('storage temporarily unavailable')
		return readStoredItems()
	})
	const confirmationWindowId = 99
	browserMock.setLiveWindowIds([confirmationWindowId])
	const removedWindowIds: number[] = []
	browserMock.setWindowRemoveHandler(async (windowId) => { removedWindowIds.push(windowId) })

	const reply = await openTransactionConfirmation()
	browserMock.setStorageGetHandler(undefined)

	assert.deepEqual(reply, { type: 'result', error: { code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, message: 'The Interceptor failed to send transaction' } })
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(removedWindowIds, [confirmationWindowId])
})

for (const { cause, error } of [
	{ cause: 'its RPC fetch fails', error: new TypeError('Failed to fetch') },
	{ cause: 'it is aborted by a newer simulation', error: new Error(NEW_BLOCK_ABORT) },
]) {
	test(`a confirmation whose first simulation ends without a result because ${ cause } is left as a failed simulation that the next refresh simulates again`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		const answerRpcRequest = fakeRequestHandler.jsonRpcRequest
		let failSimulation = true
		fakeRequestHandler.jsonRpcRequest = async (rpcRequest) => {
			if (failSimulation && rpcRequest.method === 'eth_simulateV1') throw error
			return await answerRpcRequest(rpcRequest)
		}
		try {
			assert.deepEqual(await openTransactionConfirmation(), { type: 'doNotReply' })
			const [interrupted] = await modules.getPendingTransactionsAndMessages()
			if (interrupted?.type !== 'Transaction' || interrupted.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a settled confirmation, got ${ interrupted?.transactionOrMessageCreationStatus }`)
			assert.equal(interrupted.popupVisualisation.statusCode, 'failed')

			failSimulation = false
			await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
			const [refreshed] = await modules.getPendingTransactionsAndMessages()
			if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed confirmation to stay simulated')
			assert.equal(refreshed.popupVisualisation.statusCode, 'success')
		} finally {
			fakeRequestHandler.jsonRpcRequest = answerRpcRequest
		}
	})
}

import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { activeAddress, browserMock, created, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, modules, popupVisualisation, signedTransaction, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { createDeferredValue } from './backgroundEthAccountsTestHarness.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

async function getStoredTransactionPreview() {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'Transaction')
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing simulated pending transaction')
	return [pending.transactionOrMessageCreationStatus, pending.popupVisualisation.statusCode]
}

test('a metadata refresh of an older transaction simulation does not replace a newer simulation started in the same second', async () => {
	// Stored simulation timestamps keep only whole seconds, so with a stopped clock both simulations are stored with the same start time.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		// Signing mode keeps the simulation stack out of the metadata refresh, so only the transaction's own preview is re-visualized.
		await modules.browserStorageLocalSet({ simulationMode: false, activeRpcNetwork: fakeRpcNetwork })
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, simulationMode: false }))
		const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
		await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		assert.deepEqual(await getStoredTransactionPreview(), ['Simulated', 'success'])
		let newerSimulation: Promise<void> | undefined
		// The metadata refresh reads the settings while it re-visualizes its snapshot of the transaction, so a simulation run there is stored between the snapshot and the metadata write.
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (newerSimulation === undefined && Array.isArray(keys) && keys.includes('simulationMode')) {
				fakeSafeContract.getEthSimulateFailure = () => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })
				newerSimulation = refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
				await newerSimulation
			}
			return readStoredItems()
		})

		await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService, undefined)
		browserMock.setStorageGetHandler(undefined)

		assert.ok(newerSimulation !== undefined)
		assert.deepEqual(await getStoredTransactionPreview(), ['Simulated', 'failed'])
	} finally {
		setSystemTime()
	}
})

test('a stored simulation run is only replaced by a newer run, ordered by confirmationRunId when both runs have one', async () => {
	const { shouldReplacePopupVisualisation } = await import('../../app/ts/background/confirmationPreviews.js')
	const sameSecond = new Date('2026-01-01T00:00:00.000Z')
	const run = (statusCode: 'success' | 'failed', simulationStartedTimestamp: Date, confirmationRunId?: number) => ({ statusCode, data: { ...popupVisualisation.data, simulationStartedTimestamp, ...(confirmationRunId === undefined ? {} : { confirmationRunId }) } })

	assert.equal(shouldReplacePopupVisualisation(undefined, run('failed', sameSecond, 1)), true)
	// Within one stored second, only the ids tell the runs apart, whether the older run succeeded or failed.
	assert.equal(shouldReplacePopupVisualisation(run('success', sameSecond, 2), run('failed', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('failed', sameSecond, 2), run('success', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('failed', sameSecond, 1), run('success', sameSecond, 2)), true)
	// A run stored by an older version has no id, so runs are ordered by start time.
	const nextSecond = new Date('2026-01-01T00:00:01.000Z')
	assert.equal(shouldReplacePopupVisualisation(run('success', nextSecond), run('failed', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('success', sameSecond), run('failed', nextSecond, 1)), true)
})

test('an older transaction refresh that finishes preparing after a newer refresh stored its preview does not replace it', async () => {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress })
	const stackTransaction = { signedTransaction, website: popupVisualisation.data.transactionToSimulate.website, created, originalRequestParameters: popupVisualisation.data.transactionToSimulate.originalRequestParameters, transactionIdentifier: 99n }
	await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: stackTransaction }] }))
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const getPreparedNonce = async () => {
		const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'Transaction')
		return pending?.type === 'Transaction' && pending.transactionOrMessageCreationStatus !== 'Crafting' && pending.transactionToSimulate.success ? pending.transactionToSimulate.transaction.nonce : undefined
	}
	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	// The pending transaction is first prepared after the stack transaction of the same account.
	assert.equal(await getPreparedNonce(), 1n)
	const olderRefreshPaused = createDeferredValue<void>()
	const olderRefreshReleased = createDeferredValue<void>()
	let olderRefreshHeld = false
	// The older refresh reads the simulation stack and then pauses at its first RPC request while preparing the transaction.
	const olderEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (!olderRefreshHeld) {
				olderRefreshHeld = true
				olderRefreshPaused.resolve()
				await olderRefreshReleased.promise
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const olderRefresh = refreshPopupConfirmTransactionSimulation(olderEthereum, new modules.TokenPriceService(olderEthereum, 60_000))
	await olderRefreshPaused.promise

	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	olderRefreshReleased.resolve()
	await olderRefresh

	assert.equal(await getPreparedNonce(), 0n)
})

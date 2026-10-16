import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { browserMock, fakeRpcNetwork, fakeSafeContract, modules, popupVisualisation, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
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

test('a stored simulation run is only replaced by a newer run, ordered by simulation id when both runs have one', async () => {
	const { shouldReplacePopupVisualisation } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const sameSecond = new Date('2026-01-01T00:00:00.000Z')
	const run = (statusCode: 'success' | 'failed', simulationStartedTimestamp: Date, simulationId?: number) => ({ statusCode, data: { ...popupVisualisation.data, simulationStartedTimestamp, ...(simulationId === undefined ? {} : { simulationId }) } })

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

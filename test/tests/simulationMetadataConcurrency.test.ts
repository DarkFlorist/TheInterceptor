import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { createPassthroughCompleteVisualizedSimulation, toPopupVisualisation, type CompleteVisualizedSimulation, type StoredCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { createDeferredSignal, createEthereumWithGetBlockCounter, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { pendingTransaction } from './confirmTransactionTestHarness.js'
import { waitForBackgroundTasks } from './backgroundTasksTestHarness.js'
import { getPopupVisualisationForDisplay, getStoredPopupVisualisationState, getStoredPopupVisualisationStateWithRevision, setStoredPopupVisualisationState, updateStoredPopupVisualisation } from '../../app/ts/background/storageVariables.js'
import { updateSimulationMetadata } from '../../app/ts/background/simulationUpdating.js'
import { startPopupSimulationRefreshInBackground } from '../../app/ts/background/popupSimulationRefreshQueue.js'

afterEach(waitForBackgroundTasks)

const capturedVisualisation: StoredCompleteVisualizedSimulation = {
	recordedVisualisationLookups: undefined,
	...createPassthroughCompleteVisualizedSimulation(10, 'done'),
	simulationState: { kind: 'simulated', value: pendingTransaction.popupVisualisation.data.simulationState },
}
const refreshedMetadata = {
	addressBookEntries: [{ type: 'contact', address: 42n, name: 'Refreshed name', entrySource: 'User' }] as const,
	namedTokenIds: [],
	ens: { ensNameHashes: [], ensLabelHashes: [] },
}

async function completesPromptly<T>(result: Promise<T>) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			result,
			new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Local visualization update waited for remote metadata')), 1000) }),
		])
	} finally { clearTimeout(timeout) }
}

describe('simulation metadata concurrency', () => {
	test.each(['pending invalidation', 'new result with same ID'] as const)('remote metadata does not delay or overwrite %s', async update => {
		const { runtimeMessages } = installBrowserMock()
		await setStoredPopupVisualisationState(capturedVisualisation)
		const services = createEthereumWithGetBlockCounter({ count: 0 })
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const metadata = updateSimulationMetadata(services.ethereum, undefined, {
			getMetadata: async () => { started.resolve(); await release.promise; return refreshedMetadata },
		})
		let localUpdate: Promise<unknown> | undefined
		let committed: CompleteVisualizedSimulation | undefined
		try {
			await started.promise
			localUpdate = update === 'pending invalidation'
				? startPopupSimulationRefreshInBackground({ ...services, invalidateOldState: true })
				: setStoredPopupVisualisationState({ ...capturedVisualisation, simulationState: { kind: 'simulated', value: { ...pendingTransaction.popupVisualisation.data.simulationState, blockNumber: 124n } } })
			await completesPromptly(localUpdate)
			committed = await getPopupVisualisationForDisplay()
			if (update === 'pending invalidation') {
				assert.equal(committed.simulationResultState, 'invalid')
				assert.equal(committed.simulationUpdatingState, 'updating')
				assert.ok(runtimeMessages.some(message => message.method === 'popup_simulation_state_changed'))
			} else {
				assert.equal(committed.simulationId, capturedVisualisation.simulationId)
				assert.ok(committed.simulationState.kind === 'simulated')
				assert.equal(committed.simulationState.value.blockNumber, 124n)
			}
		} finally {
			release.resolve()
			await metadata
			await localUpdate
			await waitForBackgroundTasks()
		}
		assert.deepEqual(await getPopupVisualisationForDisplay(), committed)
		assert.deepEqual(toPopupVisualisation(await metadata), committed)
	})

	test('drops metadata after a concurrent write that leaves the stored state unchanged', async () => {
		installBrowserMock()
		await setStoredPopupVisualisationState(capturedVisualisation)
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const metadata = updateSimulationMetadata(ethereum, undefined, {
			getMetadata: async () => { started.resolve(); await release.promise; return refreshedMetadata },
		})
		await started.promise
		await setStoredPopupVisualisationState(await getStoredPopupVisualisationState())
		release.resolve()
		assert.deepEqual(await metadata, capturedVisualisation)
		assert.deepEqual((await getPopupVisualisationForDisplay()).addressBookEntries, capturedVisualisation.addressBookEntries)
	})

	test('drops metadata after a concurrent write to a field unrelated to the enrichment', async () => {
		installBrowserMock()
		await setStoredPopupVisualisationState(capturedVisualisation)
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const metadata = updateSimulationMetadata(ethereum, undefined, {
			getMetadata: async () => { started.resolve(); await release.promise; return refreshedMetadata },
		})
		await started.promise
		const concurrent = await setStoredPopupVisualisationState({ ...capturedVisualisation, numberOfAddressesMadeRich: capturedVisualisation.numberOfAddressesMadeRich + 1 })
		release.resolve()
		assert.deepEqual(await metadata, concurrent)
		assert.deepEqual(await getPopupVisualisationForDisplay(), toPopupVisualisation(concurrent))
	})

	test('advances the visualisation revision on every committed write, including one that changes nothing', async () => {
		installBrowserMock()
		await setStoredPopupVisualisationState(capturedVisualisation)
		const before = await getStoredPopupVisualisationStateWithRevision()
		await setStoredPopupVisualisationState(before.visualisation)
		const afterUnchangedWrite = await getStoredPopupVisualisationStateWithRevision()
		assert.deepEqual(afterUnchangedWrite.visualisation, before.visualisation)
		assert.ok(afterUnchangedWrite.revision > before.revision)
		await updateStoredPopupVisualisation(async () => undefined)
		await setStoredPopupVisualisationState({ ...capturedVisualisation, simulationId: capturedVisualisation.simulationId - 1 })
		assert.equal((await getStoredPopupVisualisationStateWithRevision()).revision, afterUnchangedWrite.revision, 'skipped and rejected older writes store nothing, so the revision stays')
	})

	test('commits metadata when the captured visualization is still current', async () => {
		installBrowserMock()
		await setStoredPopupVisualisationState(capturedVisualisation)
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		const updated = await updateSimulationMetadata(ethereum, undefined, { getMetadata: async () => refreshedMetadata })
		assert.equal(updated.simulationId, capturedVisualisation.simulationId)
		assert.deepEqual((await getPopupVisualisationForDisplay()).addressBookEntries, refreshedMetadata.addressBookEntries)
	})
})

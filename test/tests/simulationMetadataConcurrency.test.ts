import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { createPassthroughCompleteVisualizedSimulation, type CompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { createDeferredSignal, createEthereumWithGetBlockCounter, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { pendingTransaction } from './confirmTransactionTestHarness.js'
import { waitForBackgroundTasks } from './backgroundTasksTestHarness.js'
import { getPopupVisualisationState, setPopupVisualisationState } from '../../app/ts/background/storageVariables.js'
import { updateSimulationMetadata } from '../../app/ts/background/simulationUpdating.js'
import { schedulePopupSimulationRefresh } from '../../app/ts/background/popupSimulationRefreshQueue.js'

afterEach(waitForBackgroundTasks)

const capturedVisualisation: CompleteVisualizedSimulation = {
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
		await setPopupVisualisationState(capturedVisualisation)
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
				? schedulePopupSimulationRefresh({ ...services, invalidateOldState: true })
				: setPopupVisualisationState({ ...capturedVisualisation, simulationState: { kind: 'simulated', value: { ...pendingTransaction.popupVisualisation.data.simulationState, blockNumber: 124n } } })
			await completesPromptly(localUpdate)
			committed = await getPopupVisualisationState()
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
		assert.deepEqual(await getPopupVisualisationState(), committed)
		assert.deepEqual(await metadata, committed)
	})

	test('commits metadata when the captured visualization is still current', async () => {
		installBrowserMock()
		await setPopupVisualisationState(capturedVisualisation)
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		const updated = await updateSimulationMetadata(ethereum, undefined, { getMetadata: async () => refreshedMetadata })
		assert.equal(updated.simulationId, capturedVisualisation.simulationId)
		assert.deepEqual((await getPopupVisualisationState()).addressBookEntries, refreshedMetadata.addressBookEntries)
	})
})

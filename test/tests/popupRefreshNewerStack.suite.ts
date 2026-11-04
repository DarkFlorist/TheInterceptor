import * as assert from 'assert'
import { test } from 'bun:test'
import { browserMock, fakeRequestHandler, fakeRpcNetwork, modules, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { updatePopupVisualisationIfNeeded } from '../../app/ts/background/popupVisualisationUpdater.js'
import { getPopupVisualisationState, setPopupVisualisationState } from '../../app/ts/background/storageVariables.js'
import { CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Future } from '../../app/ts/utils/future.js'
import { captureSimulationSnapshot } from '../../app/ts/background/simulationUpdating.js'

test('an older popup refresh held in its unchanged-input check does not replace the refresh for a newer stack', async () => {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork })
	// A finished visualisation for another block, so the older refresh's unchanged-input check reads the block number and then decides to refresh.
	await setPopupVisualisationState({
		...createPassthroughCompleteVisualizedSimulation(7, 'done'),
		simulationState: toResolvedSimulationState({
			success: true,
			simulationStateInput: [],
			simulatedBlocks: [],
			blockNumber: 100n,
			blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			baseFeePerGas: 1n,
			simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			rpcNetwork: fakeRpcNetwork,
		}),
		visualizedSimulationState: { success: true, visualizedBlocks: [] },
	})

	const olderRefreshReadsBlockNumber = new Future<void>()
	const releaseOlderRefresh = new Future<void>()
	let blockNumberReads = 0
	const ethereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method === 'eth_blockNumber' && blockNumberReads++ === 0) {
				olderRefreshReadsBlockNumber.resolve(undefined)
				await releaseOlderRefresh
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)

	const originalSendMessage = browser.runtime.sendMessage
	browser.runtime.sendMessage = async message => {
		if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') {
			return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
		}
		return await originalSendMessage(message)
	}
	try {
		// The older refresh captures the empty stack, then waits inside its unchanged-input check.
		const olderRefresh = updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { skipIfUnchanged: true })
		await olderRefreshReadsBlockNumber

		// Accepting the simulation-mode request appends it to the stack and refreshes the visualisation for the newer stack.
		await modules.resolvePendingTransactionOrMessage(ethereum, tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)

		releaseOlderRefresh.resolve(undefined)
		await olderRefresh
	} finally {
		releaseOlderRefresh.resolve(undefined)
		browser.runtime.sendMessage = originalSendMessage
	}

	const stored = await getPopupVisualisationState()
	assert.equal(stored.simulationUpdatingState, 'done')
	assert.equal(stored.simulationResultState, 'done')
	if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
	assert.deepEqual(stored.simulationState.value.simulationStateInput.map((block) => block.transactions.length), [1])

	const lastPublication = browserMock.sentMessages.filter((message) => message.method === 'popup_simulation_state_changed').at(-1)
	assert.deepEqual(lastPublication?.data, { visualizedSimulatorState: modules.serialize(CompleteVisualizedSimulation, stored) })
})

test('a refresh skipped as unchanged does not stop an earlier refresh from finishing an updating visualisation', async () => {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork })
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	// An updating visualisation for the current input, as a refresh whose RPC fetch failed leaves it: a skipIfUnchanged refresh finds it unchanged.
	const currentSnapshot = await captureSimulationSnapshot()
	await setPopupVisualisationState({
		...createPassthroughCompleteVisualizedSimulation(7, 'done', currentSnapshot.numberOfAddressesMadeRich),
		simulationUpdatingState: 'updating',
		simulationState: toResolvedSimulationState({
			success: true,
			simulationStateInput: currentSnapshot.simulationStateInput,
			simulatedBlocks: [],
			blockNumber: await ethereum.getBlockNumber(undefined),
			blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			baseFeePerGas: 1n,
			simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			rpcNetwork: fakeRpcNetwork,
		}),
		visualizedSimulationState: { success: true, visualizedBlocks: [] },
	})

	const earlierRefreshReadsSettings = new Future<void>()
	const releaseEarlierRefresh = new Future<void>()
	let holdNextSettingsRead = true
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (holdNextSettingsRead && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			holdNextSettingsRead = false
			earlierRefreshReadsSettings.resolve(undefined)
			await releaseEarlierRefresh
		}
		return readStoredItems()
	})
	const originalSendMessage = browser.runtime.sendMessage
	browser.runtime.sendMessage = async message => {
		if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') {
			return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
		}
		return await originalSendMessage(message)
	}
	try {
		// The earlier refresh has passed its open-consumer check and waits while capturing the stack.
		const earlierRefresh = updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
		await earlierRefreshReadsSettings

		const skipped = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { skipIfUnchanged: true })
		assert.equal(skipped.simulationId, 7)
		assert.equal(skipped.simulationUpdatingState, 'updating')

		releaseEarlierRefresh.resolve(undefined)
		await earlierRefresh
	} finally {
		releaseEarlierRefresh.resolve(undefined)
		browser.runtime.sendMessage = originalSendMessage
	}

	const stored = await getPopupVisualisationState()
	assert.equal(stored.simulationId, 8)
	assert.equal(stored.simulationUpdatingState, 'done')
	assert.equal(stored.simulationResultState, 'done')
	const lastPublication = browserMock.sentMessages.filter((message) => message.method === 'popup_simulation_state_changed').at(-1)
	assert.deepEqual(lastPublication?.data, { visualizedSimulatorState: modules.serialize(CompleteVisualizedSimulation, stored) })
})

import * as assert from 'assert'
import { test } from 'bun:test'
import { browserMock, fakeRequestHandler, fakeRpcNetwork, modules, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import { getPopupVisualisationState, setPopupVisualisationState } from '../../app/ts/background/storageVariables.js'
import { CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Future } from '../../app/ts/utils/future.js'
import { captureSimulationSnapshot } from '../../app/ts/background/simulationUpdating.js'
import type { SimulationServices, SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'

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

// Same chain on another endpoint: selecting it installs new services but keeps the simulation stack.
const otherEndpointNetwork = { ...fakeRpcNetwork, name: 'Test Chain (other endpoint)', httpsRpc: 'https://other-endpoint.example.invalid' }

function createNetworkSwitchFixture() {
	const firstEndpointReadsBlockNumber = new Future<void>()
	const releaseFirstEndpointBlockNumber = new Future<void>()
	let holdFirstEndpointBlockNumber = false
	let firstEndpointSimulations = 0
	const firstEndpointEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method === 'eth_simulateV1') firstEndpointSimulations++
			if (rpcRequest.method === 'eth_blockNumber' && holdFirstEndpointBlockNumber) {
				holdFirstEndpointBlockNumber = false
				firstEndpointReadsBlockNumber.resolve(undefined)
				await releaseFirstEndpointBlockNumber
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const firstEndpointServices: SimulationServices = { ethereum: firstEndpointEthereum, tokenPriceService: new modules.TokenPriceService(firstEndpointEthereum, 60_000) }
	const otherEndpointSimulates = new Future<void>()
	const releaseOtherEndpointSimulation = new Future<void>()
	let holdOtherEndpointSimulation = false
	const otherEndpointEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		rpcUrl: otherEndpointNetwork.httpsRpc,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }, requestAbortController?: AbortController) {
			// Like the real request handler, a cancelled refresh's requests fail, so cancelling this endpoint's refresh is observable.
			if (requestAbortController?.signal.aborted) throw new Error(requestAbortController.signal.reason)
			if (rpcRequest.method === 'eth_simulateV1' && holdOtherEndpointSimulation) {
				holdOtherEndpointSimulation = false
				otherEndpointSimulates.resolve(undefined)
				await releaseOtherEndpointSimulation
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, otherEndpointNetwork)
	const otherEndpointServices: SimulationServices = { ethereum: otherEndpointEthereum, tokenPriceService: new modules.TokenPriceService(otherEndpointEthereum, 60_000) }
	let currentServices = firstEndpointServices
	const simulationServicesOwner: SimulationServicesOwner = {
		getCurrent: () => currentServices,
		reset: () => { currentServices = otherEndpointServices; return currentServices },
	}
	return {
		firstEndpointServices,
		simulationServicesOwner,
		firstEndpointReadsBlockNumber,
		releaseFirstEndpointBlockNumber,
		holdNextFirstEndpointBlockNumber: () => { holdFirstEndpointBlockNumber = true },
		otherEndpointSimulates,
		releaseOtherEndpointSimulation,
		holdNextOtherEndpointSimulation: () => { holdOtherEndpointSimulation = true },
		releaseAll: () => {
			releaseFirstEndpointBlockNumber.resolve(undefined)
			releaseOtherEndpointSimulation.resolve(undefined)
		},
		getFirstEndpointSimulations: () => firstEndpointSimulations,
	}
}

function openVisualisationConsumer() {
	const originalSendMessage = browser.runtime.sendMessage
	browser.runtime.sendMessage = async message => {
		if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') {
			return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } }
		}
		return await originalSendMessage(message)
	}
	return () => { browser.runtime.sendMessage = originalSendMessage }
}

// Accepts the pending transaction while no consumer is open, so the stack holds it without a refresh, then selects the other endpoint and lets its refresh publish.
async function switchToOtherEndpointWithTransaction(fixture: ReturnType<typeof createNetworkSwitchFixture>, steps: { readonly beforeSwitch?: () => Promise<void>, readonly whileSwitching?: () => Promise<void> } = {}) {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork })
	await modules.resolvePendingTransactionOrMessage(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		await steps.beforeSwitch?.()
		// Imported once the harness has installed the extension globals that its imports require.
		const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
		const switching = changeActiveAddressAndChain(fixture.simulationServicesOwner, new Map(), { simulationMode: true, rpcNetwork: otherEndpointNetwork })
		await steps.whileSwitching?.()
		await switching
	} finally {
		restoreSendMessage()
	}
	const otherEndpointVisualisation = await getPopupVisualisationState()
	assert.equal(otherEndpointVisualisation.simulationUpdatingState, 'done')
	assert.equal(otherEndpointVisualisation.simulationResultState, 'done')
	if (otherEndpointVisualisation.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
	assert.equal(otherEndpointVisualisation.simulationState.value.rpcNetwork.httpsRpc, otherEndpointNetwork.httpsRpc)
	assert.deepEqual(otherEndpointVisualisation.simulationState.value.simulationStateInput.map((block) => block.transactions.length), [1])
	return otherEndpointVisualisation
}

async function assertOtherEndpointVisualisationKept(fixture: ReturnType<typeof createNetworkSwitchFixture>, otherEndpointVisualisation: CompleteVisualizedSimulation) {
	assert.deepEqual(await getPopupVisualisationState(), otherEndpointVisualisation)
	assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The stack was simulated with the services of the previously selected endpoint')
	const lastPublication = browserMock.sentMessages.filter((message) => message.method === 'popup_simulation_state_changed').at(-1)
	assert.deepEqual(lastPublication?.data, { visualizedSimulatorState: modules.serialize(CompleteVisualizedSimulation, otherEndpointVisualisation) })
}

// A finished visualisation for another block, so a refresh's unchanged-input check reads the block number and then decides to refresh.
async function storeVisualisationForAnotherBlock() {
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
}

// Starts a first-endpoint refresh and waits until its unchanged-input check holds on the block number. The refresh is wrapped so awaiting this helper does not wait for it.
async function startFirstEndpointRefreshHeldInUnchangedInputCheck(fixture: ReturnType<typeof createNetworkSwitchFixture>) {
	await storeVisualisationForAnotherBlock()
	fixture.holdNextFirstEndpointBlockNumber()
	const refresh = updatePopupVisualisationIfNeeded(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, { skipIfUnchanged: true })
	await fixture.firstEndpointReadsBlockNumber
	return { refresh }
}

test('a refresh held in its unchanged-input check leaves a newly selected endpoint to the refresh of that endpoint', async () => {
	const fixture = createNetworkSwitchFixture()
	let firstEndpointRefresh: Promise<CompleteVisualizedSimulation> | undefined
	try {
		const otherEndpointVisualisation = await switchToOtherEndpointWithTransaction(fixture, {
			beforeSwitch: async () => { firstEndpointRefresh = (await startFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)).refresh },
		})
		fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
		assert.deepEqual(await firstEndpointRefresh, otherEndpointVisualisation)
		await assertOtherEndpointVisualisationKept(fixture, otherEndpointVisualisation)
	} finally {
		fixture.releaseAll()
	}
})

test('a refresh resuming while the newly selected endpoint is being simulated does not cancel that simulation', async () => {
	const fixture = createNetworkSwitchFixture()
	let firstEndpointRefresh: Promise<CompleteVisualizedSimulation> | undefined
	try {
		const otherEndpointVisualisation = await switchToOtherEndpointWithTransaction(fixture, {
			beforeSwitch: async () => {
				firstEndpointRefresh = (await startFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)).refresh
				fixture.holdNextOtherEndpointSimulation()
			},
			// The first-endpoint refresh resumes while the other endpoint's refresh is simulating its stack. It returns without waiting for that simulation; the bounded wait keeps a refresh that instead queues behind the simulation from deadlocking the test.
			whileSwitching: async () => {
				await fixture.otherEndpointSimulates
				fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
				await Promise.race([firstEndpointRefresh, new Promise((resolve) => setTimeout(resolve, 200))])
				fixture.releaseOtherEndpointSimulation.resolve(undefined)
				await firstEndpointRefresh
			},
		})
		await assertOtherEndpointVisualisationKept(fixture, otherEndpointVisualisation)
	} finally {
		fixture.releaseAll()
	}
})

test('execution with the services of a previously selected endpoint publishes nothing for the newly selected endpoint', async () => {
	const fixture = createNetworkSwitchFixture()
	const otherEndpointVisualisation = await switchToOtherEndpointWithTransaction(fixture)
	// The executor path a refresh takes after committing: its services were replaced while it waited for the semaphore.
	await updatePopupVisualisationState(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, undefined, true)
	await assertOtherEndpointVisualisationKept(fixture, otherEndpointVisualisation)
})

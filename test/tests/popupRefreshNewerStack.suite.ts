import * as assert from 'assert'
import { test } from 'bun:test'
import { browserMock, fakeRequestHandler, fakeRpcNetwork, modules, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from '../../app/ts/background/popupVisualisationUpdater.js'
import { getPopupVisualisationState, setPopupVisualisationState } from '../../app/ts/background/storageVariables.js'
import { CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { Future } from '../../app/ts/utils/future.js'
import { buildSimulationInput, captureSimulationSnapshot } from '../../app/ts/background/simulationUpdating.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { recordInstalledServices, type SimulationServices, type SimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { queuePopupSimulationRefresh } from '../../app/ts/background/popupSimulationRefreshQueue.js'

// Both entry points: a direct refresh captures its snapshot itself, the interactive queue supplies one captured before it runs.
const olderRefreshEntryPoints = [
	{ name: 'an older popup refresh', start: async (services: SimulationServices) => await updatePopupVisualisationIfNeeded(services.ethereum, services.tokenPriceService, { skipIfUnchanged: true }) },
	{ name: 'an older queued popup refresh', start: async (services: SimulationServices) => await queuePopupSimulationRefresh(services) },
]

for (const entryPoint of olderRefreshEntryPoints) test(`${ entryPoint.name } held in its unchanged-input check does not replace the refresh for a newer stack`, async () => {
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
		const olderRefresh = entryPoint.start({ ethereum, tokenPriceService })
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
		...createPassthroughCompleteVisualizedSimulation(7, 'done', currentSnapshot.richAddresses.length),
		simulationUpdatingState: 'updating',
		simulationState: toResolvedSimulationState({
			success: true,
			simulationStateInput: (await buildSimulationInput(currentSnapshot)).simulationStateInput,
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
	let otherEndpointCancelledRequests = 0
	const otherEndpointEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		rpcUrl: otherEndpointNetwork.httpsRpc,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }, requestAbortController?: AbortController) {
			// Like the real request handler, a cancelled refresh's requests fail, so cancelling this endpoint's refresh is observable.
			if (requestAbortController?.signal.aborted) {
				otherEndpointCancelledRequests++
				throw new Error(requestAbortController.signal.reason)
			}
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
	const otherEndpointInstalled = new Future<void>()
	const simulationServicesOwner: SimulationServicesOwner = {
		getCurrent: () => currentServices,
		reset: () => {
			currentServices = otherEndpointServices
			recordInstalledServices(currentServices, simulationServicesOwner)
			otherEndpointInstalled.resolve(undefined)
			return currentServices
		},
	}
	recordInstalledServices(firstEndpointServices, simulationServicesOwner)
	return {
		firstEndpointServices,
		simulationServicesOwner,
		otherEndpointInstalled,
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
		getOtherEndpointCancelledRequests: () => otherEndpointCancelledRequests,
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

async function acceptTransactionOnFirstEndpoint(fixture: ReturnType<typeof createNetworkSwitchFixture>) {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork })
	await modules.resolvePendingTransactionOrMessage(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
	assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
}

// Accepts the pending transaction while no consumer is open, so the stack holds it without a refresh, then selects the other endpoint and lets its refresh publish.
async function switchToOtherEndpointWithTransaction(fixture: ReturnType<typeof createNetworkSwitchFixture>, steps: { readonly beforeSwitch?: () => Promise<void>, readonly whileSwitching?: () => Promise<void> } = {}) {
	await acceptTransactionOnFirstEndpoint(fixture)
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

const signerOnlyNetwork: RpcNetwork = { chainId: fakeRpcNetwork.chainId, httpsRpc: undefined, name: 'Test Chain (signer only)', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }

// Selection changes that queue no refresh of their own, so nothing would replace what a refresh left behind by them publishes. A signer-only network keeps the previous services, so these services still look current to a comparison of services alone.
const selectionChangesWithoutFollowUp = [
	{
		name: 'another endpoint',
		apply: async (fixture: ReturnType<typeof createNetworkSwitchFixture>) => {
			await modules.browserStorageLocalSet({ activeRpcNetwork: otherEndpointNetwork })
			fixture.simulationServicesOwner.reset(otherEndpointNetwork)
		},
	},
	{ name: 'a signer-only network', apply: async () => { await modules.browserStorageLocalSet({ activeRpcNetwork: signerOnlyNetwork }) } },
	{ name: 'external-wallet signing on the same endpoint', apply: async () => { await modules.browserStorageLocalSet({ simulationMode: false }) } },
]

// A queue entry waiting in its unchanged-input check, holding the snapshot captured when it was queued. The refresh is wrapped so awaiting this helper does not wait for it.
async function startQueuedFirstEndpointRefreshHeldInUnchangedInputCheck(fixture: ReturnType<typeof createNetworkSwitchFixture>) {
	await storeVisualisationForAnotherBlock()
	fixture.holdNextFirstEndpointBlockNumber()
	const refresh = queuePopupSimulationRefresh(fixture.firstEndpointServices)
	await fixture.firstEndpointReadsBlockNumber
	return { refresh }
}

const getPublications = () => browserMock.sentMessages.filter((message) => message.method === 'popup_simulation_state_changed')

async function assertRefreshLeftNoTrace(fixture: ReturnType<typeof createNetworkSwitchFixture>, visualisationBefore: CompleteVisualizedSimulation, publicationsBefore: number) {
	assert.deepEqual(await getPopupVisualisationState(), visualisationBefore)
	assert.equal(getPublications().length, publicationsBefore, 'The refresh published after the selection changed')
	assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The stack was simulated for a selection that was no longer current')
}

for (const selectionChange of selectionChangesWithoutFollowUp) test(`a queue entry left behind by selecting ${ selectionChange.name } returns from its pre-abort check without publishing`, async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		const { refresh } = await startQueuedFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)
		await selectionChange.apply(fixture)
		const visualisationBefore = await getPopupVisualisationState()
		const publicationsBefore = getPublications().length
		fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
		await refresh
		await assertRefreshLeftNoTrace(fixture, visualisationBefore, publicationsBefore)
	} finally {
		fixture.releaseAll()
		restoreSendMessage()
	}
})

for (const selectionChange of selectionChangesWithoutFollowUp) test(`execution of a snapshot left behind by selecting ${ selectionChange.name } publishes nothing`, async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	await storeVisualisationForAnotherBlock()
	const snapshot = await captureSimulationSnapshot()
	await selectionChange.apply(fixture)
	const visualisationBefore = await getPopupVisualisationState()
	const publicationsBefore = getPublications().length
	// The executor path a queue entry takes after passing its pre-abort check: the selection changed while it waited for the semaphore.
	await updatePopupVisualisationState(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, undefined, true, snapshot)
	await assertRefreshLeftNoTrace(fixture, visualisationBefore, publicationsBefore)
})

test('a queue entry for a previously selected endpoint does not cancel the refresh running for the selected endpoint', async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		const { refresh: queueEntry } = await startQueuedFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)
		await modules.browserStorageLocalSet({ activeRpcNetwork: otherEndpointNetwork })
		const otherEndpointServices = fixture.simulationServicesOwner.reset(otherEndpointNetwork)
		fixture.holdNextOtherEndpointSimulation()
		const otherEndpointRefresh = updatePopupVisualisationIfNeeded(otherEndpointServices.ethereum, otherEndpointServices.tokenPriceService)
		await fixture.otherEndpointSimulates
		// The entry returns without waiting for that simulation; the bounded wait keeps an entry that instead queues behind the simulation from deadlocking the test.
		fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
		await Promise.race([queueEntry, new Promise((resolve) => setTimeout(resolve, 200))])
		fixture.releaseOtherEndpointSimulation.resolve(undefined)
		await otherEndpointRefresh
		await queueEntry
		assert.equal(fixture.getOtherEndpointCancelledRequests(), 0, 'The queue entry cancelled the refresh of the selected endpoint')
		const stored = await getPopupVisualisationState()
		assert.equal(stored.simulationUpdatingState, 'done')
		assert.equal(stored.simulationResultState, 'done')
		if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
		assert.equal(stored.simulationState.value.rpcNetwork.httpsRpc, otherEndpointNetwork.httpsRpc)
		assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The stack was simulated with the services of the previously selected endpoint')
	} finally {
		fixture.releaseAll()
		restoreSendMessage()
	}
})

test('a queue entry for a previously selected endpoint publishes nothing after a switch to external-wallet signing, which queues no refresh', async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		const { refresh } = await startQueuedFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)
		// Imported once the harness has installed the extension globals that its imports require.
		const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
		await changeActiveAddressAndChain(fixture.simulationServicesOwner, new Map(), { simulationMode: false, rpcNetwork: otherEndpointNetwork })
		const visualisationBefore = await getPopupVisualisationState()
		const publicationsBefore = getPublications().length
		fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
		await refresh
		await assertRefreshLeftNoTrace(fixture, visualisationBefore, publicationsBefore)
	} finally {
		fixture.releaseAll()
		restoreSendMessage()
	}
})

test('a queue entry publishes a stack edit made after it was queued, even when the stack it was queued with is unchanged', async () => {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork })
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	// A finished visualisation of the stack the entry is queued with, so only an input built after the edit shows anything to do.
	const queuedSnapshot = await captureSimulationSnapshot()
	await setPopupVisualisationState({
		...createPassthroughCompleteVisualizedSimulation(7, 'done', queuedSnapshot.richAddresses.length),
		simulationState: toResolvedSimulationState({
			success: true,
			simulationStateInput: (await buildSimulationInput(queuedSnapshot)).simulationStateInput,
			simulatedBlocks: [],
			blockNumber: await ethereum.getBlockNumber(undefined),
			blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			baseFeePerGas: 1n,
			simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			rpcNetwork: fakeRpcNetwork,
		}),
		visualizedSimulationState: { success: true, visualizedBlocks: [] },
	})

	const entryProbesConsumer = new Future<void>()
	const releaseEntry = new Future<void>()
	let consumerProbes = 0
	const originalSendMessage = browser.runtime.sendMessage
	browser.runtime.sendMessage = async message => {
		if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_isSimulationVisualizerOpen') {
			// Only the entry finds a consumer open, so the accept below edits the stack without refreshing it.
			const isEntry = consumerProbes++ === 0
			if (isEntry) {
				entryProbesConsumer.resolve(undefined)
				await releaseEntry
			}
			return { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: isEntry } }
		}
		return await originalSendMessage(message)
	}
	try {
		const queueEntry = queuePopupSimulationRefresh({ ethereum, tokenPriceService })
		await entryProbesConsumer
		await modules.resolvePendingTransactionOrMessage(ethereum, tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
		releaseEntry.resolve(undefined)
		await queueEntry
	} finally {
		releaseEntry.resolve(undefined)
		browser.runtime.sendMessage = originalSendMessage
	}

	const stored = await getPopupVisualisationState()
	if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
	assert.deepEqual(stored.simulationState.value.simulationStateInput.map((block) => block.transactions.length), [1])
})

// Replacing the RPC list installs the chain's primary entry without changing the selected network, so services and settings name different endpoints from then on.
async function replaceRpcListWithOtherEndpointAsPrimary(fixture: ReturnType<typeof createNetworkSwitchFixture>) {
	// Imported once the harness has installed the extension globals that their imports require.
	const { setNewRpcList } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	await setNewRpcList(fixture.simulationServicesOwner, { method: 'popup_set_rpc_list', data: [{ ...otherEndpointNetwork, primary: true }] }, await getSettings())
}

async function assertOtherEndpointPublishedTransaction() {
	const stored = await getPopupVisualisationState()
	assert.equal(stored.simulationUpdatingState, 'done')
	assert.equal(stored.simulationResultState, 'done')
	if (stored.simulationState.kind !== 'simulated') throw new Error('Expected a simulated visualisation')
	assert.equal(stored.simulationState.value.rpcNetwork.httpsRpc, otherEndpointNetwork.httpsRpc)
	assert.deepEqual(stored.simulationState.value.simulationStateInput.map((block) => block.transactions.length), [1])
	assert.deepEqual(getPublications().at(-1)?.data, { visualizedSimulatorState: modules.serialize(CompleteVisualizedSimulation, stored) })
}

test('a popup refresh with the services installed by replacing the RPC list simulates and publishes while the selected network stays unchanged', async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		await replaceRpcListWithOtherEndpointAsPrimary(fixture)
		const { getSettings } = await import('../../app/ts/background/settings.js')
		assert.equal((await getSettings()).activeRpcNetwork.httpsRpc, fakeRpcNetwork.httpsRpc)
		// The reset queues the refresh for the services it installed.
		await assertOtherEndpointPublishedTransaction()
		const services = fixture.simulationServicesOwner.getCurrent()
		await updatePopupVisualisationIfNeeded(services.ethereum, services.tokenPriceService, { invalidateOldState: true })
		await assertOtherEndpointPublishedTransaction()
		assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The stack was simulated with the replaced services')
	} finally {
		fixture.releaseAll()
		restoreSendMessage()
	}
})

// Every way the background replaces the installed services: replacing the RPC list, which keeps the selected network, and selecting another endpoint.
const serviceResets = [
	{ name: 'replacing the RPC list', apply: replaceRpcListWithOtherEndpointAsPrimary },
	{
		name: 'selecting another endpoint',
		apply: async (fixture: ReturnType<typeof createNetworkSwitchFixture>) => {
			const { changeActiveAddressAndChain } = await import('../../app/ts/background/activeSettings.js')
			await changeActiveAddressAndChain(fixture.simulationServicesOwner, new Map(), { simulationMode: true, rpcNetwork: otherEndpointNetwork })
		},
	},
]

for (const serviceReset of serviceResets) test(`after ${ serviceReset.name }, a refresh still holding the replaced services steps aside and the installed services publish`, async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const restoreSendMessage = openVisualisationConsumer()
	try {
		const { refresh } = await startFirstEndpointRefreshHeldInUnchangedInputCheck(fixture)
		await serviceReset.apply(fixture)
		await assertOtherEndpointPublishedTransaction()
		const publicationsBefore = getPublications().length
		fixture.releaseFirstEndpointBlockNumber.resolve(undefined)
		await refresh
		assert.equal(getPublications().length, publicationsBefore, 'The refresh holding the replaced services published')
		assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The stack was simulated with the replaced services')
		await assertOtherEndpointPublishedTransaction()
	} finally {
		fixture.releaseAll()
		restoreSendMessage()
	}
})

test('a reset landing while the execution guard reads the settings stops the replaced services from simulating', async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const snapshot = await captureSimulationSnapshot()
	const guardReadsSettings = new Future<void>()
	const releaseGuardRead = new Future<void>()
	let holdNextSettingsRead = true
	// With a supplied snapshot, the execution guard is the first settings read: building the input reads only the stack and block time settings.
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (holdNextSettingsRead && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			holdNextSettingsRead = false
			guardReadsSettings.resolve(undefined)
			await releaseGuardRead
		}
		return readStoredItems()
	})
	const restoreSendMessage = openVisualisationConsumer()
	try {
		const execution = updatePopupVisualisationState(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, undefined, true, snapshot)
		await guardReadsSettings
		// The replacement's own refresh waits for the semaphore this execution holds, so only the reset itself is awaited here.
		const replacing = replaceRpcListWithOtherEndpointAsPrimary(fixture)
		await fixture.otherEndpointInstalled
		releaseGuardRead.resolve(undefined)
		await execution
		await replacing
		assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The replaced services simulated after the reset')
		await assertOtherEndpointPublishedTransaction()
	} finally {
		releaseGuardRead.resolve(undefined)
		fixture.releaseAll()
		restoreSendMessage()
	}
})

test('a refresh resuming from its pre-abort settings read after a reset does not cancel the refresh running on the replacement services', async () => {
	const fixture = createNetworkSwitchFixture()
	await acceptTransactionOnFirstEndpoint(fixture)
	const snapshot = await captureSimulationSnapshot()
	const guardReadsSettings = new Future<void>()
	const releaseGuardRead = new Future<void>()
	let holdNextSettingsRead = true
	// With a supplied snapshot and invalidation, which skips the unchanged-input check, the pre-abort guard is the first settings read.
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (holdNextSettingsRead && Array.isArray(keys) && keys.includes('activeRpcNetwork')) {
			holdNextSettingsRead = false
			guardReadsSettings.resolve(undefined)
			await releaseGuardRead
		}
		return readStoredItems()
	})
	const restoreSendMessage = openVisualisationConsumer()
	try {
		// The call an older queue entry makes with the snapshot it was queued with.
		const olderRefresh = updatePopupVisualisationIfNeeded(fixture.firstEndpointServices.ethereum, fixture.firstEndpointServices.tokenPriceService, { invalidateOldState: true, snapshot })
		await guardReadsSettings
		// The reset queues the refresh for the replacement services, held here while it simulates.
		fixture.holdNextOtherEndpointSimulation()
		const replacing = replaceRpcListWithOtherEndpointAsPrimary(fixture)
		await fixture.otherEndpointSimulates
		releaseGuardRead.resolve(undefined)
		// The older refresh returns without waiting for that simulation; the bounded wait keeps one that instead queues behind it from deadlocking the test.
		await Promise.race([olderRefresh, new Promise((resolve) => setTimeout(resolve, 200))])
		fixture.releaseOtherEndpointSimulation.resolve(undefined)
		await replacing
		await olderRefresh
		assert.equal(fixture.getOtherEndpointCancelledRequests(), 0, 'The older refresh cancelled the refresh running on the replacement services')
		assert.equal(fixture.getFirstEndpointSimulations(), 0, 'The replaced services simulated after the reset')
		await assertOtherEndpointPublishedTransaction()
	} finally {
		releaseGuardRead.resolve(undefined)
		fixture.releaseAll()
		restoreSendMessage()
	}
})

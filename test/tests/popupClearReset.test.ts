import * as assert from 'assert'
import * as funtypes from 'funtypes'
import type { CompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { CompleteVisualizedSimulation as CompleteVisualizedSimulationCodec, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { describe, test } from 'bun:test'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

type BrowserMock = {
	reset: () => void
	sentMessages: RuntimeMessage[]
	setPopupOpen: (isOpen: boolean) => void
}

type BrowserMockGlobals = {
	runtime: {
		lastError: { message?: string } | null | undefined
		sendMessage: (message: RuntimeMessage) => Promise<unknown>
		getManifest: () => { manifest_version: number }
		onMessage: { addListener: () => undefined; removeListener: () => undefined }
		onConnect: { addListener: () => undefined; removeListener: () => undefined }
	}
	storage: {
		local: {
			get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>
			set: (items: Record<string, unknown>) => Promise<void>
			remove: (keys: string | string[]) => Promise<void>
		}
	}
	tabs: {
		query: () => Promise<unknown[]>
		get: () => Promise<undefined>
		update: () => Promise<undefined>
		onUpdated: { addListener: () => undefined; removeListener: () => undefined }
		onRemoved: { addListener: () => undefined; removeListener: () => undefined }
	}
	windows: {
		get: () => Promise<undefined>
		update: () => Promise<undefined>
	}
	action: {
		setIcon: () => Promise<undefined>
		setTitle: () => Promise<undefined>
		setBadgeText: () => Promise<undefined>
		setBadgeBackgroundColor: () => Promise<undefined>
	}
	browserAction: {
		setIcon: () => Promise<undefined>
		setTitle: () => Promise<undefined>
		setBadgeText: () => Promise<undefined>
		setBadgeBackgroundColor: () => Promise<undefined>
	}
	declarativeNetRequest: {
		getDynamicRules: () => Promise<readonly { id: number }[]>
		getSessionRules: () => Promise<readonly { id: number }[]>
		updateDynamicRules: (update: { removeRuleIds: readonly number[]; addRules?: readonly unknown[] }) => Promise<void>
		updateSessionRules: (update: { removeRuleIds: readonly number[]; addRules?: readonly unknown[] }) => Promise<void>
	}
}

const PopupSimulationChangedMessage = funtypes.ReadonlyObject({
	role: funtypes.Literal('all'),
	method: funtypes.Literal('popup_simulation_state_changed'),
	data: funtypes.ReadonlyObject({
		visualizedSimulatorState: CompleteVisualizedSimulationCodec,
	}),
}).asReadonly()

function createBrowserMock(): BrowserMock {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	let popupIsOpen = true
	const getItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	const removeItems = (keys: string | string[]) => {
		const entries = Array.isArray(keys) ? keys : [keys]
		for (const key of entries) delete storageState[key]
	}

	const browserMock = {
		runtime: {
			lastError: null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { method: 'popup_isMainPopupWindowOpen', data: { isOpen: popupIsOpen } }
				}
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) { return getItems(keys) },
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) { removeItems(keys) },
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		declarativeNetRequest: {
			async getDynamicRules() { return [] },
			async getSessionRules() { return [] },
			async updateDynamicRules() { return undefined },
			async updateSessionRules() { return undefined },
		},
	} satisfies BrowserMockGlobals

	const installBrowserGlobals = () => {
		Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
		Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
	}

	installBrowserGlobals()

	return {
		sentMessages,
		setPopupOpen(isOpen: boolean) {
			popupIsOpen = isOpen
		},
		reset() {
			for (const key of Object.keys(storageState)) delete storageState[key]
			sentMessages.length = 0
			installBrowserGlobals()
			browserMock.runtime.lastError = null
			popupIsOpen = true
		},
	}
}

const browserMock = createBrowserMock()

async function loadModules() {
	const popupVisualisationUpdater = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const popupSimulationFingerprint = await import('../../app/ts/background/popupSimulationFingerprint.js')
	const popupMessageHandlers = await import('../../app/ts/background/popupMessageHandlers.js')
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const settings = await import('../../app/ts/background/settings.js')
	const background = await import('../../app/ts/background/background.js')
	const simulationUpdating = await import('../../app/ts/background/simulationUpdating.js')
	const simulationMode = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	return {
		...popupVisualisationUpdater,
		...popupSimulationFingerprint,
		...popupMessageHandlers,
		...storageUtils,
		...settings,
		...background,
		...simulationUpdating,
		...simulationMode,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

function buildStalePopupVisualisationState(
	rpcNetwork: TestModules['defaultRpcs'][number],
	defaultBlockManipulation: TestModules['DEFAULT_BLOCK_MANIPULATION'],
) {
	const simulationState = {
		success: true as const,
		simulationStateInput: [{
			stateOverrides: {},
			transactions: [],
			signedMessages: [],
			blockTimeManipulation: defaultBlockManipulation,
			simulateWithZeroBaseFee: false,
		}],
		simulatedBlocks: [{
			simulatedTransactions: [],
			signedMessages: [],
			stateOverrides: {},
			blockTimestamp: new Date('2024-01-01T00:00:12.000Z'),
			blockTimeManipulation: defaultBlockManipulation,
			blockBaseFeePerGas: 1n,
		}],
		blockNumber: 123n,
		blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		baseFeePerGas: 1n,
		simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		rpcNetwork,
	}

	return {
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		simulationState: toResolvedSimulationState(simulationState),
		simulationUpdatingState: 'done' as const,
		simulationResultState: 'done' as const,
		simulationId: 7,
		visualizedSimulationState: {
			success: true as const,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation: defaultBlockManipulation,
			}],
		},
		numberOfAddressesMadeRich: 0,
	}
}

function createFakeEthereum(rpcNetwork: TestModules['defaultRpcs'][number]) {
	let blockPolling = false
	return {
		isBlockPolling() {
			return blockPolling
		},
		setBlockPolling(enabled: boolean) {
			blockPolling = enabled
		},
		async getBlockNumber() {
			return 123n
		},
		getCachedBlock() {
			return {
				number: 123n,
				timestamp: new Date('2024-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				gasLimit: 30_000_000n,
			}
		},
		async getBlock() {
			return {
				number: 123n,
				timestamp: new Date('2024-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				gasLimit: 30_000_000n,
			}
		},
		getRpcEntry() {
			return rpcNetwork
		},
		getChainId() {
			return rpcNetwork.chainId
		},
	}
}

function getSimulationStateChangedMessages(messages: RuntimeMessage[]) {
	return messages.filter((message) => message.method === 'popup_simulation_state_changed')
}

function getExpectedPopupSimulationChangedMessage(popupVisualisation: CompleteVisualizedSimulation) {
	return serialize(PopupSimulationChangedMessage, {
		role: 'all',
		method: 'popup_simulation_state_changed',
		data: { visualizedSimulatorState: popupVisualisation },
	} as const)
}

function assertDefinedEmptyPopupVisualisation(
	popupVisualisation: CompleteVisualizedSimulation,
	defaultBlockManipulation: TestModules['DEFAULT_BLOCK_MANIPULATION'],
) {
	assert.equal(popupVisualisation.simulationUpdatingState, 'done')
	assert.equal(popupVisualisation.simulationResultState, 'done')
	assert.equal(popupVisualisation.simulationState.kind, 'simulated')
	assert.equal(popupVisualisation.simulationState.value.success, true)
	assert.deepEqual(popupVisualisation.simulationState.value.simulationStateInput, [{
		stateOverrides: {},
		transactions: [],
		signedMessages: [],
		blockTimeManipulation: defaultBlockManipulation,
		simulateWithZeroBaseFee: false,
	}])
	assert.deepEqual(popupVisualisation.visualizedSimulationState, {
		success: true,
		visualizedBlocks: [{
			simulatedAndVisualizedTransactions: [],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation: defaultBlockManipulation,
		}],
	})
}

const {
	updatePopupVisualisationIfNeeded,
	browserStorageLocalGet,
	browserStorageLocalSet,
	changeActiveRpc,
	defaultActiveAddresses,
	defaultRpcs,
	resetSimulationStateFromConfig,
	DEFAULT_BLOCK_MANIPULATION,
} = await modulesPromise

const activeAddress = defaultActiveAddresses[0]?.address
const rpcNetwork = defaultRpcs[0]
const sameChainRpcNetwork = defaultRpcs[3]
const otherChainRpcNetwork = defaultRpcs[1]
if (activeAddress === undefined || rpcNetwork === undefined || sameChainRpcNetwork === undefined || otherChainRpcNetwork === undefined) throw new Error('test defaults are missing')

const stalePopupVisualisation = buildStalePopupVisualisationState(rpcNetwork, DEFAULT_BLOCK_MANIPULATION)
const fakeEthereum = createFakeEthereum(rpcNetwork) as never as Parameters<typeof updatePopupVisualisationIfNeeded>[0]
const fakeTokenPriceService = {} as never as Parameters<typeof updatePopupVisualisationIfNeeded>[1]

describe('popup clear reset', () => {
	test('keeps the cached popup timestamp when refresh finds no simulation change', async () => {
		browserMock.reset()
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			interceptorTransactionStack: { operations: [] },
		})
		const modules = await modulesPromise
		const currentSimulationInput = await modules.getCurrentSimulationInput()
		const matchingPopupVisualisation = {
			...stalePopupVisualisation,
			simulationState: {
				...stalePopupVisualisation.simulationState,
				simulationStateInput: currentSimulationInput,
			},
		}
		await browserStorageLocalSet({ popupVisualisation: matchingPopupVisualisation })
		const storedPopupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(storedPopupVisualisation)
		const storedSimulationState = storedPopupVisualisation.simulationState
		assert.equal(storedSimulationState.kind, 'simulated')
		assert.equal(
			modules.getPopupVisualisationFingerprint(currentSimulationInput, rpcNetwork, 123n),
			modules.getPopupVisualisationFingerprint(storedSimulationState.value.simulationStateInput, storedSimulationState.value.rpcNetwork, storedSimulationState.value.blockNumber),
		)
		const popupVisualisation = await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService, false, false, true)
		assert.equal(popupVisualisation.simulationId, matchingPopupVisualisation.simulationId)
		assert.equal(popupVisualisation.simulationState.kind, 'simulated')
		assert.equal(matchingPopupVisualisation.simulationState.kind, 'simulated')
		assert.equal(popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime(), matchingPopupVisualisation.simulationState.value.simulationConductedTimestamp.getTime())
		assert.equal(getSimulationStateChangedMessages(browserMock.sentMessages).length, 0)
	})

	test('updates the cached popup active address without restamping the simulation', async () => {
		browserMock.reset()
		const nextActiveAddress = defaultActiveAddresses.find((entry) => entry.address !== activeAddress)?.address
		if (nextActiveAddress === undefined) throw new Error('test defaults are missing a second active address')
		await browserStorageLocalSet({
			activeSimulationAddress: nextActiveAddress,
			simulationMode: true,
			currentTabId: -1,
			interceptorTransactionStack: { operations: [] },
		})
		await browser.storage.local.set({
			'tabState_-1': {
				tabId: -1,
				website: undefined,
				signerConnected: false,
				signerName: 'NoSignerDetected',
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				tabIconDetails: { icon: '../img/head.png', iconReason: 'The website has not requested to connect to The Interceptor.' },
				activeSigningAddress: undefined,
			},
		} as never)
		const modules = await modulesPromise
		const currentSimulationInput = await modules.getCurrentSimulationInput()
		const matchingPopupVisualisation = {
			...stalePopupVisualisation,
			simulationState: {
				...stalePopupVisualisation.simulationState,
				simulationStateInput: currentSimulationInput,
			},
		}
		await browserStorageLocalSet({ popupVisualisation: matchingPopupVisualisation })

		const { refreshHomeData } = modules
		await refreshHomeData(fakeEthereum, fakeTokenPriceService, new Map(), true, 1, false)

		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(popupVisualisation)
		assert.equal('activeAddress' in popupVisualisation, false)
		assert.equal(popupVisualisation.simulationState.kind, 'simulated')
		assert.equal(matchingPopupVisualisation.simulationState.kind, 'simulated')
		assert.equal(popupVisualisation.simulationState.value.simulationConductedTimestamp.getTime(), matchingPopupVisualisation.simulationState.value.simulationConductedTimestamp.getTime())

		const homePageMessage = browserMock.sentMessages.find((message) => message.method === 'popup_UpdateHomePage')
		assert.ok(homePageMessage)
		assert.equal((homePageMessage as { data: { settings: { activeSimulationAddress: bigint | undefined } } }).data.settings.activeSimulationAddress, nextActiveAddress)
	})

	test('publish an empty popup visualisation even when previous state was done', async () => {
		browserMock.reset()
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [] },
		})

		await updatePopupVisualisationIfNeeded(fakeEthereum, fakeTokenPriceService, false, false)

		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.ok(popupVisualisation)
		assert.equal(popupVisualisation.simulationId, stalePopupVisualisation.simulationId + 1)
		assertDefinedEmptyPopupVisualisation(popupVisualisation, DEFAULT_BLOCK_MANIPULATION)

		const changedMessages = getSimulationStateChangedMessages(browserMock.sentMessages)
		assert.equal(changedMessages.length > 0, true)
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('clear the interceptor stack and refresh popup state during reset', async () => {
		browserMock.reset()
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] },
		})

		await resetSimulationStateFromConfig(fakeEthereum, fakeTokenPriceService)

		const interceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(interceptorTransactionStack, { operations: [] })
		assert.ok(popupVisualisation)
		assertDefinedEmptyPopupVisualisation(popupVisualisation, DEFAULT_BLOCK_MANIPULATION)

		const changedMessages = getSimulationStateChangedMessages(browserMock.sentMessages)
		assert.equal(changedMessages.length > 0, true)
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('preserves the interceptor stack when changing rpc within the same chain', async () => {
		browserMock.reset()
		browserMock.setPopupOpen(false)
		const resets: TestModules['defaultRpcs'][number][] = []
		const resetSimulationServices = (nextRpcEntry: TestModules['defaultRpcs'][number]) => {
			resets.push(nextRpcEntry)
		}
		const interceptorTransactionStack = { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] as const }
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			activeRpcNetwork: rpcNetwork,
			simulationMode: true,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack,
		})

		await changeActiveRpc(fakeEthereum, fakeTokenPriceService, resetSimulationServices, new Map(), sameChainRpcNetwork, true)

		const modules = await modulesPromise
		const updatedSettings = await modules.getSettings()
		const storedInterceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(updatedSettings.activeRpcNetwork, sameChainRpcNetwork)
		assert.deepEqual(storedInterceptorTransactionStack, interceptorTransactionStack)
		assert.deepEqual(popupVisualisation, stalePopupVisualisation)
		assert.deepEqual(resets, [sameChainRpcNetwork])
		assert.equal(getSimulationStateChangedMessages(browserMock.sentMessages).length, 0)
	})

	test('clears the interceptor stack when changing rpc to another chain', async () => {
		browserMock.reset()
		const resets: TestModules['defaultRpcs'][number][] = []
		const resetSimulationServices = (nextRpcEntry: TestModules['defaultRpcs'][number]) => {
			resets.push(nextRpcEntry)
		}
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			activeRpcNetwork: rpcNetwork,
			simulationMode: true,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] },
		})

		await changeActiveRpc(fakeEthereum, fakeTokenPriceService, resetSimulationServices, new Map(), otherChainRpcNetwork, true)

		const modules = await modulesPromise
		const updatedSettings = await modules.getSettings()
		const interceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
		const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
		assert.deepEqual(updatedSettings.activeRpcNetwork, otherChainRpcNetwork)
		assert.deepEqual(interceptorTransactionStack, { operations: [] })
		assert.ok(popupVisualisation)
		assertDefinedEmptyPopupVisualisation(popupVisualisation, DEFAULT_BLOCK_MANIPULATION)
		assert.deepEqual(resets, [otherChainRpcNetwork])

		const changedMessages = getSimulationStateChangedMessages(browserMock.sentMessages)
		assert.equal(changedMessages.length > 0, true)
		assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
	})

	test('return the complete visualized simulation reply through the background popup handler', async () => {
		browserMock.reset()
		await browserStorageLocalSet({
			activeSimulationAddress: activeAddress,
			popupVisualisation: stalePopupVisualisation,
			interceptorTransactionStack: { operations: [] },
		})

		const modules = await modulesPromise
		const reply = await modules.popupMessageHandler(
			new Map(),
			fakeEthereum,
			fakeTokenPriceService,
			(() => undefined) as never,
			{ method: 'popup_requestCompleteVisualizedSimulation' },
			await modules.getSettings(),
		)

		assert.ok(reply !== undefined && reply !== null && typeof reply === 'object' && 'method' in reply && reply.method === 'popup_requestCompleteVisualizedSimulation')
		assert.ok('visualizedSimulatorState' in reply)
		const visualizedSimulatorState = reply.visualizedSimulatorState
		assert.ok(visualizedSimulatorState !== undefined && visualizedSimulatorState !== null && typeof visualizedSimulatorState === 'object')
		assert.ok('simulationId' in visualizedSimulatorState && 'simulationResultState' in visualizedSimulatorState && 'simulationState' in visualizedSimulatorState)
		assert.equal(visualizedSimulatorState.simulationId, stalePopupVisualisation.simulationId)
		assert.equal(visualizedSimulatorState.simulationResultState, stalePopupVisualisation.simulationResultState)
		const simulationState = visualizedSimulatorState.simulationState
		assert.ok(simulationState !== undefined && simulationState !== null && typeof simulationState === 'object' && 'kind' in simulationState)
		assert.equal(simulationState.kind, 'simulated')
		assert.equal(simulationState.value.blockNumber, '0x7b')
	})
})

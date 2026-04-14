import * as assert from 'assert'
import type { CompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { describe, run, runIfRoot, should } from '../micro-should.js'

type RuntimeMessage = {
	method?: string
	type?: string
	data?: unknown
}

type BrowserMock = {
	reset: () => void
	sentMessages: RuntimeMessage[]
}

function createBrowserMock(): BrowserMock {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

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

	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage(message: RuntimeMessage) {
				sentMessages.push(message)
				if (message.method === 'popup_isMainPopupWindowOpen') {
					return { type: 'RequestIsMainPopupWindowOpenReply', data: { isOpen: true } }
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
	} as unknown as typeof globalThis.browser
	(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }

	return {
			sentMessages,
			reset() {
				for (const key of Object.keys(storageState)) delete storageState[key]
				sentMessages.length = 0;
				(globalThis.browser.runtime as unknown as { lastError: undefined }).lastError = undefined
			},
		}
	}

const browserMock = createBrowserMock()

async function loadModules() {
	const popupVisualisationUpdater = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const settings = await import('../../app/ts/background/settings.js')
	const background = await import('../../app/ts/background/background.js')
	const simulationMode = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	return {
		...popupVisualisationUpdater,
		...storageUtils,
		...settings,
		...background,
		...simulationMode,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

function buildStalePopupVisualisationState(
	rpcNetwork: TestModules['defaultRpcs'][number],
	activeAddress: bigint,
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
		simulationState,
		activeAddress,
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
	return {
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
	return serialize(MessageToPopup, {
		method: 'popup_simulation_state_changed',
		data: { visualizedSimulatorState: popupVisualisation },
	} as any)
}

export async function main() {
	const {
		updatePopupVisualisationIfNeeded,
		browserStorageLocalGet,
		browserStorageLocalSet,
		defaultActiveAddresses,
		defaultRpcs,
		resetSimulatorStateFromConfig,
		DEFAULT_BLOCK_MANIPULATION,
	} = await modulesPromise

	const activeAddress = defaultActiveAddresses[0]?.address
	const rpcNetwork = defaultRpcs[0]
	if (activeAddress === undefined || rpcNetwork === undefined) throw new Error('test defaults are missing')

	const stalePopupVisualisation = buildStalePopupVisualisationState(rpcNetwork, activeAddress, DEFAULT_BLOCK_MANIPULATION)
	const fakeSimulator = { ethereum: createFakeEthereum(rpcNetwork), tokenPriceService: {} }
	const typedPopupSimulator = fakeSimulator as never as Parameters<typeof updatePopupVisualisationIfNeeded>[0]
	const typedResetSimulator = fakeSimulator as never as Parameters<typeof resetSimulatorStateFromConfig>[0]

	describe('popup clear reset', () => {
		should('publish an empty popup visualisation even when previous state was done', async () => {
			browserMock.reset()
			await browserStorageLocalSet({
				activeSimulationAddress: activeAddress,
				popupVisualisation: stalePopupVisualisation,
				interceptorTransactionStack: { operations: [] },
			})

			await updatePopupVisualisationIfNeeded(typedPopupSimulator, false, false)

			const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
			assert.ok(popupVisualisation)
			assert.equal(popupVisualisation.simulationUpdatingState, 'done')
			assert.equal(popupVisualisation.simulationResultState, 'done')
			assert.equal(popupVisualisation.simulationId, stalePopupVisualisation.simulationId + 1)
			assert.equal(popupVisualisation.simulationState, undefined)
			assert.deepEqual(popupVisualisation.visualizedSimulationState, { success: true, visualizedBlocks: [] })

			const changedMessages = getSimulationStateChangedMessages(browserMock.sentMessages)
			assert.equal(changedMessages.length > 0, true)
			assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
		})

		should('clear the interceptor stack and refresh popup state during reset', async () => {
			browserMock.reset()
			await browserStorageLocalSet({
				activeSimulationAddress: activeAddress,
				popupVisualisation: stalePopupVisualisation,
				interceptorTransactionStack: { operations: [{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION }] },
			})

			await resetSimulatorStateFromConfig(typedResetSimulator)

			const interceptorTransactionStack = (await browserStorageLocalGet('interceptorTransactionStack')).interceptorTransactionStack
			const popupVisualisation = (await browserStorageLocalGet('popupVisualisation')).popupVisualisation
			assert.deepEqual(interceptorTransactionStack, { operations: [] })
			assert.ok(popupVisualisation)
			assert.equal(popupVisualisation.simulationUpdatingState, 'done')
			assert.equal(popupVisualisation.simulationResultState, 'done')
			assert.equal(popupVisualisation.simulationState, undefined)
			assert.deepEqual(popupVisualisation.visualizedSimulationState, { success: true, visualizedBlocks: [] })

			const changedMessages = getSimulationStateChangedMessages(browserMock.sentMessages)
			assert.equal(changedMessages.length > 0, true)
			assert.deepEqual(changedMessages.at(-1), getExpectedPopupSimulationChangedMessage(popupVisualisation))
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)

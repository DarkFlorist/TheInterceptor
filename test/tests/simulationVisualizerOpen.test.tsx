import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, CompleteVisualizedSimulation, PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { UpdateHomePage, type Settings } from '../../app/ts/types/interceptor-messages.js'
import { serialize, type EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { installDomMock } from './domMock.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined
type TestDomNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly getAttribute?: (name: string) => string | null
	scrollIntoView?: (options?: ScrollIntoViewOptions) => void
}

function installBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const sentMessages: unknown[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					return undefined
				},
				onMessage: {
					addListener(listener: RuntimeMessageListener) {
						listeners.push(listener)
					},
					removeListener(listener: RuntimeMessageListener) {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return { listeners, sentMessages }
}

function StackVisualizerHookProbe() {
	useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return <div>ready</div>
}

function CrossTabStackVisualizerHookProbe() {
	const { tabState } = useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
		filterByTabId: false,
	})
	return <div>{ tabState.value?.tabIconDetails.iconReason ?? 'empty' }</div>
}

function sendRuntimeMessage(listener: RuntimeMessageListener, message: unknown) {
	let response: unknown
	const returned = listener(message, {}, (nextResponse?: unknown) => {
		response = nextResponse
	})
	return { returned, response }
}

function collectElements(node: TestDomNode | null | undefined, tagName: string, results: TestDomNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function findElementById(root: TestDomNode, id: string) {
	return collectElements(root, 'li').find((element) => element.getAttribute?.('id') === id)
}

function hasCompactStackCard(root: TestDomNode) {
	return collectElements(root, 'header').some((header) => header.textContent?.replace(/\s+/g, ' ').trim() === 'Stack')
}

function installQueuedAnimationFrames() {
	const animationFrames: FrameRequestCallback[] = []
	globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
		animationFrames.push(callback)
		return animationFrames.length
	}
	return () => {
		const pendingFrames = animationFrames.splice(0)
		for (const callback of pendingFrames) callback(0)
	}
}

const settings: Settings = {
	activeSimulationAddress: undefined,
	activeRpcNetwork: {
		name: 'Ethereum',
		chainId: '0x1',
		httpsRpc: 'https://example.invalid',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: false,
	},
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: false,
}

function createHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich = 0): UpdateHomePage {
	return {
		method: 'popup_UpdateHomePage',
		popupRefreshGeneration,
		data: {
			visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(0, 'done', numberOfAddressesMadeRich),
			activeAddresses: [],
			richList: [],
			makeCurrentAddressRich: false,
			latestUnexpectedError: undefined,
			websiteAccessAddressMetadata: [],
			tabState: {
				tabId,
				website: { websiteOrigin: `https://tab-${ tabId }.example`, icon: undefined, title: `Tab ${ tabId }` },
				signerConnected: false,
				signerName: 'NoSigner',
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				tabIconDetails: { icon: '../img/head-not-active.png', iconReason },
				activeSigningAddress: undefined,
			},
			currentBlockNumber: undefined,
			settings,
			rpcConnectionStatus: undefined,
			activeSigningAddressInThisTab: undefined,
			tabId,
			rpcEntries: [settings.activeRpcNetwork],
			interceptorDisabled: false,
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0x0', deltaUnit: 'Seconds' },
		},
	}
}

function createPreSimulationTransaction(transactionIdentifier: bigint): PreSimulationTransaction {
	const sendTransactionParams = {
		from: 0x1000000000000000000000000000000000000001n,
		to: 0x2000000000000000000000000000000000000002n,
		value: 0n,
		input: new Uint8Array(),
		gas: 21_000n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
	}
	const transaction: EthereumUnsignedTransaction = {
		type: '1559',
		...sendTransactionParams,
		nonce: transactionIdentifier,
		chainId: 1n,
	}
	const signedTransaction = mockSignTransaction(transaction)
	return {
		signedTransaction,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [sendTransactionParams],
		},
		transactionIdentifier,
	}
}

function createSerializableSettings(): Settings {
	return {
		...settings,
		activeSimulationAddress: undefined,
		activeRpcNetwork: {
			...settings.activeRpcNetwork,
			chainId: 1n,
		},
	}
}

function createSimulatedCompleteVisualizedSimulation(serializableSettings: Settings): CompleteVisualizedSimulation {
	const blockTimeManipulation: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }
	const simulationStateInput = [{
		stateOverrides: {},
		transactions: [createPreSimulationTransaction(1n)],
		signedMessages: [],
		blockTimeManipulation,
		simulateWithZeroBaseFee: false,
	}]
	return {
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		simulationState: {
			kind: 'simulated',
			value: {
				success: true,
				simulationStateInput,
				simulatedBlocks: [],
				blockNumber: 100n,
				blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
				rpcNetwork: serializableSettings.activeRpcNetwork,
			},
		},
		simulationUpdatingState: 'done',
		simulationResultState: 'done',
		simulationId: 1,
		visualizedSimulationState: {
			success: true,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation,
			}],
		},
		numberOfAddressesMadeRich: 0,
	}
}

function createStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason)
	const serializableSettings = createSerializableSettings()
	return {
		...update,
		data: {
			...update.data,
			visualizedSimulatorState: createSimulatedCompleteVisualizedSimulation(serializableSettings),
			settings: serializableSettings,
			rpcEntries: [serializableSettings.activeRpcNetwork],
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		},
	}
}

describe('simulation visualizer open replies', () => {
	test('stack visualizer hook answers the visualizer-open probe but not the main-popup probe', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(StackVisualizerHookProbe, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected hook to register a runtime listener')

			const visualizerReply = sendRuntimeMessage(listener, { method: 'popup_isSimulationVisualizerOpen' })
			assert.equal(visualizerReply.returned, true)
			assert.deepEqual(visualizerReply.response, { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } })

			const mainPopupReply = sendRuntimeMessage(listener, { method: 'popup_isMainPopupWindowOpen' })
			assert.equal(mainPopupReply.returned, undefined)
			assert.equal(mainPopupReply.response, undefined)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer hook accepts updates from a different tab id', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(CrossTabStackVisualizerHookProbe, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected hook to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(10, 1, 'First tab') }, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('First tab'), true)

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(11, 2, 'Second tab') }, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Second tab'), true)
			assert.equal(dom.document.body.textContent?.includes('First tab'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows rich-only state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...createHomePageUpdate(12, 1, 'Rich tab', 2) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Simply making 2 addresses rich'), true)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows stack operations without an active simulation address', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(13, 1, 'Stack tab')) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			assert.ok(findElementById(dom.document.body, 'simulation-stack-transaction-0x1'))
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer target hash no-ops when the target element cannot scroll', async () => {
		const dom = installDomMock()
		const flushAnimationFrames = installQueuedAnimationFrames()
		const { listeners } = installBrowserMock()
		Object.defineProperty(globalThis.window, 'location', {
			configurable: true,
			writable: true,
			value: { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'no-scroll') },
		})
		Object.defineProperty(dom.document, 'getElementById', {
			configurable: true,
			value: (id: string) => findElementById(dom.document.body, id) ?? null,
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(14, 1, 'Stack tab')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})

			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute?.('class')?.includes('simulation-stack-row--highlighted'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer target hash no-ops when target lookup is unavailable', async () => {
		const dom = installDomMock()
		const flushAnimationFrames = installQueuedAnimationFrames()
		const { listeners } = installBrowserMock()
		Object.defineProperty(globalThis.window, 'location', {
			configurable: true,
			writable: true,
			value: { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'no-lookup') },
		})
		Object.defineProperty(dom.document, 'getElementById', {
			configurable: true,
			value: undefined,
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(16, 1, 'Stack tab')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})

			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute?.('class')?.includes('simulation-stack-row--highlighted'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer target hash scrolls to and highlights the matching row', async () => {
		const dom = installDomMock()
		const flushAnimationFrames = installQueuedAnimationFrames()
		const { listeners } = installBrowserMock()
		const scrollCalls: ScrollIntoViewOptions[] = []
		Object.defineProperty(globalThis.window, 'location', {
			configurable: true,
			writable: true,
			value: { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'scroll') },
		})
		Object.defineProperty(dom.document, 'getElementById', {
			configurable: true,
			value: (id: string) => {
				const element = findElementById(dom.document.body, id)
				if (element === undefined) return null
				element.scrollIntoView = (options?: ScrollIntoViewOptions) => {
					if (options !== undefined) scrollCalls.push(options)
				}
				return element
			},
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(15, 1, 'Stack tab')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})

			assert.deepStrictEqual(scrollCalls.at(-1), { behavior: 'smooth', block: 'center' })
			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute?.('class')?.includes('simulation-stack-row--highlighted'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer target hash does not replay after same-hash updates', async () => {
		const dom = installDomMock()
		const flushAnimationFrames = installQueuedAnimationFrames()
		const { listeners } = installBrowserMock()
		const scrollCalls: ScrollIntoViewOptions[] = []
		Object.defineProperty(globalThis.window, 'location', {
			configurable: true,
			writable: true,
			value: { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'retry') },
		})
		Object.defineProperty(dom.document, 'getElementById', {
			configurable: true,
			value: (id: string) => {
				const element = findElementById(dom.document.body, id)
				if (element === undefined) return null
				element.scrollIntoView = (options?: ScrollIntoViewOptions) => {
					if (options !== undefined) scrollCalls.push(options)
				}
				return element
			},
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 0)

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(17, 1, 'Stack tab')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 1)

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(17, 2, 'Stack tab refresh')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 1)

			globalThis.window.location.hash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'retry-again')
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(17, 3, 'Stack tab retarget')) }, {}, () => undefined)
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 2)
		} finally {
			dom.restore()
		}
	})
	})

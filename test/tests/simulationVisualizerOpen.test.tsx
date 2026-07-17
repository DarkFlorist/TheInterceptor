import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, CompleteVisualizedSimulation, PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { MessageToPopup, UpdateHomePage, type Settings } from '../../app/ts/types/interceptor-messages.js'
import { serialize, type EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { installDomMock } from './domMock.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined
type TestDomNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly getAttribute?: (name: string) => string | null
	readonly l?: Record<string, (event: unknown) => unknown>
	scrollIntoView?: (options?: ScrollIntoViewOptions) => void
}

function installBrowserMock(sendMessageReply?: (message: unknown) => unknown | Promise<unknown>) {
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
					return await sendMessageReply?.(message)
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

function installClipboardMock() {
	const previousNavigator = globalThis.navigator
	const copiedText: string[] = []
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		writable: true,
		value: {
			clipboard: {
				async writeText(text: string) {
					copiedText.push(text)
				},
			},
		},
	})
	return {
		copiedText,
		restore() {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				writable: true,
				value: previousNavigator,
			})
		},
	}
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

async function clickElement(element: { l?: Record<string, (event: unknown) => unknown> }) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element, stopPropagation() { return undefined } })
}

function getHeadersContainingText(root: TestDomNode, text: string) {
	return collectElements(root, 'header').filter((header) => header.textContent?.includes(text) === true)
}

function countTextOccurrences(input: string, text: string) {
	return input.split(text).length - 1
}

function findElementById(root: TestDomNode, id: string) {
	const elements = [
		...collectElements(root, 'li'),
		...collectElements(root, 'div'),
	]
	return elements.find((element) => element.getAttribute?.('id') === id)
}

function hasCompactStackCard(root: TestDomNode) {
	return collectElements(root, 'header').some((header) => header.textContent?.replace(/\s+/g, ' ').trim() === 'Stack')
}

function hasClass(node: TestDomNode, className: string) {
	return node.getAttribute?.('class')?.split(/\s+/).includes(className) === true
}

function findElementByClass(root: TestDomNode, tagName: string, className: string) {
	return collectElements(root, tagName).find((element) => hasClass(element, className))
}

function getFirstElementChild(node: TestDomNode) {
	return (node.childNodes ?? []).find((child) => child.tagName !== undefined)
}

function getElementChildren(node: TestDomNode) {
	return (node.childNodes ?? []).filter((child) => child.tagName !== undefined)
}

function hasAncestorWithClass(node: TestDomNode, className: string) {
	let currentNode = node.parentNode
	while (currentNode !== undefined && currentNode !== null) {
		if (hasClass(currentNode, className)) return true
		currentNode = currentNode.parentNode
	}
	return false
}

function hasButtonWithText(root: TestDomNode, text: string) {
	return collectElements(root, 'button').some((button) => button.textContent?.replace(/\s+/g, ' ').trim() === text)
}

function getButtonByText(root: TestDomNode, text: string) {
	const button = collectElements(root, 'button').find((button) => button.textContent?.replace(/\s+/g, ' ').trim() === text)
	if (button === undefined) throw new Error(`Expected button with text "${ text }"`)
	return button
}

function getParagraphByAriaLabel(root: TestDomNode, ariaLabel: string) {
	const paragraph = collectElements(root, 'p').find((element) => element.getAttribute?.('aria-label') === ariaLabel)
	if (paragraph === undefined) throw new Error(`Expected paragraph with aria-label "${ ariaLabel }"`)
	return paragraph
}

function getRichAddressGroups(paragraph: TestDomNode) {
	return (paragraph.childNodes ?? []).filter((child) => child.tagName === 'SPAN' && hasClass(child, 'rich-address-sentence-group'))
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

function createRichAddressEntry(address: bigint, name: string): AddressBookEntry {
	return {
		type: 'contact',
		name,
		address,
		entrySource: 'User',
		askForAddressAccess: true,
		useAsActiveAddress: true,
	}
}

function createRichListElement(address: bigint, name: string): EnrichedRichListElement {
	return {
		addressBookEntry: createRichAddressEntry(address, name),
		makingRich: true,
		type: 'UserAdded',
	}
}

function createHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich = 0, richList: readonly EnrichedRichListElement[] = []): UpdateHomePage {
	return {
		method: 'popup_UpdateHomePage',
		homeDataSource: 'fresh',
		popupRefreshGeneration,
		data: {
			visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(0, 'done', numberOfAddressesMadeRich),
			activeAddresses: [],
			richList,
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

function createSimulatedCompleteVisualizedSimulation(serializableSettings: Settings, transactionIdentifiers: readonly bigint[] = [1n], numberOfAddressesMadeRich = 0): CompleteVisualizedSimulation {
	const blockTimeManipulation: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }
	const simulationStateInput = [{
		stateOverrides: {},
		transactions: transactionIdentifiers.map(createPreSimulationTransaction),
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
		numberOfAddressesMadeRich,
	}
}

function createStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, transactionIdentifiers: readonly bigint[] = [1n], numberOfAddressesMadeRich = 0, richList: readonly EnrichedRichListElement[] = []): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason, numberOfAddressesMadeRich, richList)
	const serializableSettings = createSerializableSettings()
	return {
		...update,
		data: {
			...update.data,
			visualizedSimulatorState: createSimulatedCompleteVisualizedSimulation(serializableSettings, transactionIdentifiers, numberOfAddressesMadeRich),
			settings: serializableSettings,
			rpcEntries: [serializableSettings.activeRpcNetwork],
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		},
	}
}

function createSerializableRichHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich: number, richList: readonly EnrichedRichListElement[]): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason, numberOfAddressesMadeRich, richList)
	const serializableSettings = createSerializableSettings()
	return {
		...update,
		data: {
			...update.data,
			settings: serializableSettings,
			rpcEntries: [serializableSettings.activeRpcNetwork],
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		},
	}
}

function createSimulationStateChangedMessage(visualizedSimulatorState: CompleteVisualizedSimulation): MessageToPopup {
	return {
		role: 'all',
		method: 'popup_simulation_state_changed',
		data: { visualizedSimulatorState },
	}
}

function createFailedStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason)
	const serializableSettings = createSerializableSettings()
	const blockTimeManipulation: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }
	return {
		...update,
		data: {
			...update.data,
			visualizedSimulatorState: {
				addressBookEntries: [],
				tokenPriceEstimates: [],
				tokenPriceQuoteToken: undefined,
				namedTokenIds: [],
				simulationState: {
					kind: 'simulated',
					value: {
						success: false,
						simulationStateInput: [{
							stateOverrides: {},
							transactions: [createPreSimulationTransaction(1n)],
							signedMessages: [],
							blockTimeManipulation,
							simulateWithZeroBaseFee: false,
						}],
						jsonRpcError: {
							jsonrpc: '2.0',
							id: 1,
							error: { code: 3, message: 'execution reverted' },
						},
						blockNumber: 100n,
						blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
						baseFeePerGas: 1n,
						simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
						rpcNetwork: serializableSettings.activeRpcNetwork,
					},
				},
				simulationUpdatingState: 'failed',
				simulationResultState: 'invalid',
				simulationId: 2,
				visualizedSimulationState: {
					success: false,
					jsonRpcError: {
						jsonrpc: '2.0',
						id: 1,
						error: { code: 3, message: 'execution reverted' },
					},
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation,
					}],
				},
				numberOfAddressesMadeRich: 0,
			},
			settings: serializableSettings,
			rpcEntries: [serializableSettings.activeRpcNetwork],
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		},
	}
}

describe('simulation visualizer open replies', () => {
	test('stack visualizer entrypoint wraps the page in Hint for toolbar feedback', async () => {
		const source = await Bun.file('app/ts/simulationStack.ts').text()

		assert.match(source, /import Hint from '\.\/components\/subcomponents\/Hint\.js'/)
		assert.match(source, /preact\.createElement\(Hint,\s*\{\s*children:\s*preact\.createElement\(SimulationStackPage,\s*\{\}\)\s*\}\)/)
	})

	test('stack visualizer entrypoint clears the shell loading placeholder before rendering', async () => {
		const dom = installDomMock()
		installBrowserMock()
		const root = dom.document.createElement('div')
		root.setAttribute('id', 'simulation-stack-root')
		root.textContent = 'Loading...'
		dom.document.body.appendChild(root)
		Object.defineProperty(dom.document, 'getElementById', {
			configurable: true,
			value: (id: string) => id === 'simulation-stack-root' ? root : null,
		})
		try {
			await act(async () => {
				await import(`../../app/ts/simulationStack.ts?entrypoint-test=${ crypto.randomUUID() }`)
			})
			assert.equal(root.textContent?.includes('Loading...'), false)
		} finally {
			await act(() => {
				render(null, root)
			})
			dom.restore()
		}
	})

	test('Hint resolves copied feedback from nested toolbar click targets', async () => {
		const source = await Bun.file('app/ts/components/subcomponents/Hint.tsx').text()

		assert.match(source, /target\.closest\(`\[\$\{ attribute \}\]`\)/)
		assert.match(source, /getHintElement\(event\.target,\s*copyAttribute\)/)
	})

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
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
			createRichListElement(0x2000000000000000000000000000000000000002n, 'Treasury Two'),
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury, Cold'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSerializableRichHomePageUpdate(12, 1, 'Rich tab', 3, richList)) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Simply making 3 addresses rich'), true)
			assert.equal(dom.document.body.textContent?.includes('Addresses being made rich are'), true)
			assert.equal(dom.document.body.textContent?.includes('Treasury One'), true)
			assert.equal(dom.document.body.textContent?.includes('Treasury Two'), true)
			assert.equal(dom.document.body.textContent?.includes('Treasury, Cold'), true)
			const richAddressParagraph = getParagraphByAriaLabel(dom.document.body, 'Addresses being made rich are Treasury One, Treasury Two and Treasury, Cold.')
			const richAddressGroups = getRichAddressGroups(richAddressParagraph)
			assert.equal(richAddressGroups.length, 3)
			assert.equal(richAddressGroups[0]?.textContent?.endsWith(','), true)
			assert.equal(richAddressGroups[2]?.textContent?.startsWith(' and '), true)
			assert.equal(richAddressGroups[2]?.textContent?.includes('Treasury, Cold'), true)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
			assert.equal(collectElements(dom.document.body, 'nav').some((nav) => hasClass(nav, 'window-header')), false)
			assert.ok(findElementByClass(dom.document.body, 'div', 'simulation-stack-page'))
			const richHeader = collectElements(dom.document.body, 'header').find((header) => header.textContent?.includes('Simply making 3 addresses rich') === true)
			assert.ok(richHeader)
			assert.equal(String(richHeader.getAttribute?.('aria-expanded')), 'true')
			assert.ok(findElementByClass(richHeader, 'div', 'card-header-icon'))
			assert.ok(findElementByClass(richHeader, 'p', 'card-header-title'))
			await act(async () => {
				await clickElement(richHeader)
			})
			assert.equal(String(richHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(dom.document.body.textContent?.includes('Addresses being made rich are'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer rich address sentence handles one entry', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSerializableRichHomePageUpdate(12, 1, 'Rich tab', 1, richList)) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Address being made rich is'), true)
			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute?.('aria-label') === 'Address being made rich is Treasury One.'), true)
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
			assert.equal(dom.document.body.textContent?.includes('Import, export, and adjust the simulation stack.'), true)
			assert.equal(dom.document.body.textContent?.includes('Loading...'), false)
			assert.equal(hasButtonWithText(dom.document.body, 'Import'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Export'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Clear'), true)
			assert.equal(getButtonByText(dom.document.body, 'Import').getAttribute?.('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Export').getAttribute?.('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Clear').getAttribute?.('class')?.includes('is-small') ?? false, false)
			assert.equal(dom.document.body.textContent?.includes('Export Simulation Stack'), false)
			assert.equal(hasCompactStackCard(dom.document.body), false)
			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.textContent?.includes('Pending transaction'), true)
			assert.equal(targetRow.textContent?.includes('Simulate delay'), false)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer keeps the page header first when an unexpected error is visible', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		const update = createStackHomePageUpdate(13, 1, 'Stack tab')
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({
					role: 'all',
					...serialize(UpdateHomePage, {
						...update,
						data: {
							...update.data,
							latestUnexpectedError: {
								method: 'popup_UnexpectedErrorOccured',
								data: {
									message: 'render failed',
									timestamp: new Date('2024-01-01T00:00:00.000Z'),
									source: 'simulationStack',
									code: 'render_error',
									debugId: undefined,
								},
							},
						},
					}),
				}, {}, () => undefined)
			})

			const layout = findElementByClass(dom.document.body, 'div', 'simulation-stack-page')
			assert.ok(layout)
			assert.equal(getFirstElementChild(layout)?.tagName, 'HEADER')
			assert.equal(getFirstElementChild(layout)?.textContent?.includes('Simulation Stack'), true)
			const layoutChildren = getElementChildren(layout)
			assert.equal(layoutChildren[1]?.tagName, 'DIV')
			assert.equal(hasClass(layoutChildren[1], 'simulation-stack-page-body'), true)
			assert.equal(dom.document.body.textContent?.includes('An unexpected error occured!'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows rich addresses in simulated stack state', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		const richList = [
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury Three'),
			createRichListElement(0x4000000000000000000000000000000000000004n, 'Treasury Four'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(13, 1, 'Stack tab', [1n], 2, richList)) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent?.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent?.includes('Addresses being made rich are'), true)
			assert.equal(dom.document.body.textContent?.includes('Treasury Three'), true)
			assert.equal(dom.document.body.textContent?.includes('Treasury Four'), true)
			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute?.('aria-label') === 'Addresses being made rich are Treasury Three and Treasury Four.'), true)
			const richHeader = collectElements(dom.document.body, 'header').find((header) => header.textContent?.includes('Simply making 2 addresses rich') === true)
			assert.ok(richHeader)
			assert.equal(String(richHeader.getAttribute?.('aria-expanded')), 'true')

			await act(async () => {
				await clickElement(richHeader)
			})
			assert.equal(String(richHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(dom.document.body.textContent?.includes('Addresses being made rich are'), false)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer refreshes rich metadata after live simulation updates', async () => {
		const dom = installDomMock()
		const { listeners, sentMessages } = installBrowserMock()
		const serializableSettings = createSerializableSettings()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(19, 1, 'Stack tab')) }, {}, () => undefined)
			})
			sentMessages.splice(0)

			await act(() => {
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation(serializableSettings, [1n], 1))), {}, () => undefined)
			})

			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestNewHomeData'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer failure banner stays readable outside blurred simulation content', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createFailedStackHomePageUpdate(16, 1, 'Failed stack tab')) }, {}, () => undefined)
			})

			const errorMessage = 'Failed to simulate the stack due to error: "execution reverted". Please modify the stack to make it simutable.'
			const errorBanner = collectElements(dom.document.body, 'p').find((element) => element.textContent?.includes(errorMessage) === true)
			assert.ok(errorBanner)
			assert.equal(hasAncestorWithClass(errorBanner, 'blur'), false)
			const blurredContent = findElementByClass(dom.document.body, 'div', 'blur')
			assert.ok(blurredContent)
			assert.equal(blurredContent?.textContent?.includes('Pending transaction') ?? false, true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer export button copies the simulation stack export payload', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const exportPayload = '{ "name": "Interceptor Simulation Export" }'
		const { listeners, sentMessages } = installBrowserMock((message) => {
			if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestInterceptorSimulationInput') {
				return { method: 'popup_requestInterceptorSimulationInput', ethSimulateV1InputString: exportPayload }
			}
			return undefined
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(19, 1, 'Stack tab')) }, {}, () => undefined)
			})

			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
			})

			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestInterceptorSimulationInput'), true)
			assert.deepStrictEqual(clipboardMock.copiedText, [exportPayload])
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('stack visualizer transaction cards collapse and reopen independently', async () => {
		const dom = installDomMock()
		const { listeners } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const listener = listeners[0]
			if (listener === undefined) throw new Error('Expected page to register a runtime listener')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(18, 1, 'Stack tab', [1n, 2n])) }, {}, () => undefined)
			})

			const transactionHeaders = getHeadersContainingText(dom.document.body, 'Pending transaction')
			assert.equal(transactionHeaders.length, 2)
			const firstHeader = transactionHeaders[0]
			const secondHeader = transactionHeaders[1]
			if (firstHeader === undefined || secondHeader === undefined) throw new Error('Expected two transaction headers')
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 2)

			await act(async () => {
				await clickElement(firstHeader)
			})
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 1)
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), true)

			await act(async () => {
				await clickElement(secondHeader)
			})
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 0)
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), true)

			await act(async () => {
				await clickElement(firstHeader)
			})
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 1)

			await act(async () => {
				await clickElement(secondHeader)
			})
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 2)
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
			const targetHeader = getHeadersContainingText(dom.document.body, 'Pending transaction')[0]
			if (targetHeader === undefined) throw new Error('Expected target transaction header')
			await act(async () => {
				await clickElement(targetHeader)
			})
			assert.equal(String(targetHeader.getAttribute?.('aria-expanded')), 'false')
			await act(() => {
				flushAnimationFrames()
			})

			assert.deepStrictEqual(scrollCalls.at(-1), { behavior: 'smooth', block: 'center' })
			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute?.('class')?.includes('simulation-stack-row--highlighted'), true)
			assert.equal(String(targetHeader.getAttribute?.('aria-expanded')), 'true')
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

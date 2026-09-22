import { usePopupSettingsChanges } from '../../app/ts/components/hooks/usePopupSettingsChanges.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { App } from '../../app/ts/components/App.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { CompleteVisualizedSimulation, type BlockTimeManipulation, type PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { MessageToPopup, PopupMessage, UpdateHomePage, type Settings } from '../../app/ts/types/interceptor-messages.js'
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
	const dispatchMessage: RuntimeMessageListener = (message, sender, sendResponse) => {
		let responsePending: boolean | undefined
		for (const listener of listeners) {
			if (listener(message, sender, sendResponse) === true) responsePending = true
		}
		return responsePending
	}
	return { listeners, sentMessages, dispatchMessage }
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

function MainPopupSimulationStateProbe() {
	const { simVisResults } = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return <div>{ simVisResults.value.kind }</div>
}

function AddressSelectionProbe() {
	const { activeSimulationAddress, simVisResults, simulationUpdatingState } = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return <div>{ activeSimulationAddress.value?.toString() }/{ simVisResults.value.kind }/{ simulationUpdatingState.value ?? 'loading' }</div>
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

function isHomeDataRequest(message: unknown, refreshSignerAccounts: boolean, includeWebsiteAccessAddressMetadata: boolean) {
	return typeof message === 'object'
		&& message !== null
		&& 'method' in message
		&& message.method === 'popup_requestNewHomeData'
		&& 'data' in message
		&& typeof message.data === 'object'
		&& message.data !== null
		&& 'refreshSignerAccounts' in message.data
		&& message.data.refreshSignerAccounts === refreshSignerAccounts
		&& 'includeWebsiteAccessAddressMetadata' in message.data
		&& message.data.includeWebsiteAccessAddressMetadata === includeWebsiteAccessAddressMetadata
}

function collectElements(node: TestDomNode | null | undefined, tagName: string, results: TestDomNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

async function clickElement(element: { l?: Record<string, (event: unknown) => unknown> }) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element, clientX: 100, clientY: 50, stopPropagation() { return undefined } })
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

function hasButtonWithAriaLabel(root: TestDomNode, ariaLabel: string) {
	return collectElements(root, 'button').some((button) => button.getAttribute?.('aria-label') === ariaLabel)
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
			hasSafeTransactionsToExport: true,
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
		simulationMode: true,
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
	const safeAddress = 0x3000000000000000000000000000000000000003n
	const safeOwnerAddress = 0x1000000000000000000000000000000000000001n
	const serializableSettings = { ...createSerializableSettings(), activeSigningSafeAddress: safeAddress, simulationMode: false }
	return {
		...update,
		data: {
			...update.data,
			tabState: { ...update.data.tabState, signerConnected: true, signerAccounts: [safeOwnerAddress], activeSigningAddress: safeOwnerAddress },
			activeSigningAddressInThisTab: safeAddress,
			activeAddresses: [{ type: 'safe', name: 'Test Safe', address: safeAddress, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSimulationSignerAddress: safeOwnerAddress, safeSignerAddresses: [safeOwnerAddress] }],
			visualizedSimulatorState: createSimulatedCompleteVisualizedSimulation(serializableSettings, transactionIdentifiers, numberOfAddressesMadeRich),
			settings: serializableSettings,
			rpcEntries: [serializableSettings.activeRpcNetwork],
			preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
		},
	}
}

function createNonSafeStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
	const update = createStackHomePageUpdate(tabId, popupRefreshGeneration, iconReason)
	const nonSafeAddress = 0x4000000000000000000000000000000000000004n
	return {
		...update,
		data: {
			...update.data,
			activeAddresses: [{ type: 'contact', name: 'Not a Safe', address: nonSafeAddress, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }],
			activeSigningAddressInThisTab: nonSafeAddress,
			settings: { ...update.data.settings, activeSigningSafeAddress: undefined },
		},
	}
}

function createSimulationStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
	const update = createStackHomePageUpdate(tabId, popupRefreshGeneration, iconReason)
	const simulationAddress = 0x4000000000000000000000000000000000000004n
	const simulationSettings = {
		...update.data.settings,
		simulationMode: true,
		activeSimulationAddress: simulationAddress,
		activeSigningSafeAddress: undefined,
	}
	return {
		...update,
		data: {
			...update.data,
			activeAddresses: [{ type: 'contact', name: 'Simulation address', address: simulationAddress, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }],
			activeSigningAddressInThisTab: undefined,
			settings: simulationSettings,
			visualizedSimulatorState: createSimulatedCompleteVisualizedSimulation(simulationSettings),
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
		const { dispatchMessage: listener, sentMessages } = installBrowserMock()
		try {
			await act(() => {
				render(h(StackVisualizerHookProbe, {}), dom.document.body)
			})

			assert.equal(sentMessages.some(message => PopupMessage.safeParse(message).success && typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestSettingsChangeStatus'), false)

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
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(CrossTabStackVisualizerHookProbe, {}), dom.document.body)
			})

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

	test('main popup hook keeps Safe simulation results without a simulation-mode address', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(MainPopupSimulationStateProbe, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(12, 1, 'Safe stack')) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent, 'simulated')
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer page shows rich-only state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
			createRichListElement(0x2000000000000000000000000000000000000002n, 'Treasury Two'),
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury, Cold'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
		const { dispatchMessage: listener } = installBrowserMock()
		const richList = [
			createRichListElement(0x1000000000000000000000000000000000000001n, 'Treasury One'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSimulationStackHomePageUpdate(13, 1, 'Stack tab')) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent?.includes('Import, export, and adjust the simulation stack.'), true)
			assert.equal(dom.document.body.textContent?.includes('Loading...'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Export'), true)
			assert.equal(hasButtonWithText(dom.document.body, 'Clear stack'), true)
			assert.equal(getButtonByText(dom.document.body, 'Import').getAttribute?.('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Export').getAttribute?.('class')?.includes('is-small') ?? false, false)
			assert.equal(getButtonByText(dom.document.body, 'Clear stack').getAttribute?.('class')?.includes('is-small') ?? false, false)
			const headerControls = findElementByClass(dom.document.body, 'nav', 'simulation-stack-page-controls')
			assert.ok(headerControls)
			assert.equal(collectElements(headerControls, 'button').length, 3)
			assert.equal(findElementByClass(dom.document.body, 'nav', 'simulation-stack-page-actions'), undefined)
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

	test('stack visualizer uses the signing Safe as the visualized address in signing mode', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		const update = createStackHomePageUpdate(13, 1, 'Safe signing stack', [1n], 1)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({
					role: 'all',
					...serialize(UpdateHomePage, {
						...update,
						data: { ...update.data, makeCurrentAddressRich: true },
					}),
				}, {}, () => undefined)
			})

			assert.equal(collectElements(dom.document.body, 'p').some((paragraph) => paragraph.getAttribute?.('aria-label') === 'Address being made rich is Test Safe.'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer remains a Gnosis Safe stack when the current tab cannot resolve the Safe owner', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		const update = createStackHomePageUpdate(13, 1, 'Safe signing stack', [1n], 0)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({
					role: 'all',
					...serialize(UpdateHomePage, {
						...update,
						data: {
							...update.data,
							activeSigningAddressInThisTab: 0x1000000000000000000000000000000000000001n,
							tabState: { ...update.data.tabState, signerConnected: false, signerAccounts: [], activeSigningAddress: undefined },
						},
					}),
				}, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer keeps the page header first when an unexpected error is visible', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		const update = createStackHomePageUpdate(13, 1, 'Stack tab')
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
			assert.equal(getFirstElementChild(layout)?.textContent?.includes('Gnosis Safe Stack'), true)
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
		const { dispatchMessage: listener } = installBrowserMock()
		const richList = [
			createRichListElement(0x3000000000000000000000000000000000000003n, 'Treasury Three'),
			createRichListElement(0x4000000000000000000000000000000000000004n, 'Treasury Four'),
		]
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
		const { dispatchMessage: listener, sentMessages } = installBrowserMock()
		const serializableSettings = createSerializableSettings()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSimulationStackHomePageUpdate(19, 1, 'Stack tab')) }, {}, () => undefined)
			})
			sentMessages.splice(0)

			await act(() => {
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation(serializableSettings, [1n], 1))), {}, () => undefined)
			})

			assert.equal(sentMessages.some((message) => isHomeDataRequest(message, false, false)), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer failure banner stays readable outside blurred simulation content', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
		const { dispatchMessage: listener, sentMessages } = installBrowserMock((message) => {
			if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestInterceptorSimulationInput') {
				return { method: 'popup_requestInterceptorSimulationInput', ok: true, ethSimulateV1InputString: exportPayload }
			}
			return undefined
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSimulationStackHomePageUpdate(19, 1, 'Stack tab')) }, {}, () => undefined)
			})

			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			assert.equal(sentMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestInterceptorSimulationInput'), true)
			assert.deepStrictEqual(clipboardMock.copiedText, [exportPayload])
			assert.equal(dom.document.body.textContent?.includes('Copied!'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute?.('disabled'), null)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('stack visualizer hides a simulation export error after switching to Safe mode', async () => {
		const dom = installDomMock()
		const exportError = 'Simulation stack export failed.'
		const { dispatchMessage: listener } = installBrowserMock((message) => {
			if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestInterceptorSimulationInput') {
				return { method: 'popup_requestInterceptorSimulationInput', ok: false, message: exportError }
			}
			return undefined
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const simulationUpdate = createSimulationStackHomePageUpdate(26, 1, 'Simulation stack tab')
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, simulationUpdate) }, {}, () => undefined)
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.equal(dom.document.body.textContent?.includes(exportError), true)

			await act(async () => {
				listener(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: { ...simulationUpdate.data.settings, simulationMode: false },
				}), {}, () => undefined)
				await Promise.resolve()
			})
			assert.equal(dom.document.body.textContent?.includes(exportError), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer Safe export copies with feedback and a cooldown', async () => {
		const dom = installDomMock()
		const clipboardMock = installClipboardMock()
		const safeExportPayload = '{ "name": "Interceptor Safe Stack" }'
		const { dispatchMessage: listener } = installBrowserMock((message) => {
			if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestSafeStackExport') {
				return { method: 'popup_requestSafeStackExport', ok: true, safeStackJson: safeExportPayload }
			}
			return undefined
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(24, 1, 'Stack tab')) }, {}, () => undefined)
			})

			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			assert.deepStrictEqual(clipboardMock.copiedText, [safeExportPayload])
			assert.equal(dom.document.body.textContent?.includes('Copied!'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute?.('disabled'), null)
		} finally {
			clipboardMock.restore()
			dom.restore()
		}
	})

	test('stack visualizer hides simulation import and export in Safe signing mode', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(20, 1, 'Stack tab')) }, {}, () => undefined)
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer shows the reason when copying Safe transactions is refused', async () => {
		const dom = installDomMock()
		const exportError = 'The simulation stack has no Safe proposals to export.'
		const { dispatchMessage: listener } = installBrowserMock((message) => {
			if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestSafeStackExport') {
				return { method: 'popup_requestSafeStackExport', ok: false, message: exportError }
			}
			return undefined
		})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(21, 1, 'Stack tab')) }, {}, () => undefined)
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Export'))
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			assert.equal(dom.document.body.textContent?.includes(exportError), true)

		} finally {
			dom.restore()
		}
	})

	test('stack visualizer shows Safe actions only when signing with an active Safe', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock(() => undefined)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const update = createStackHomePageUpdate(23, 1, 'Stack tab')
			const activeSafe = update.data.activeAddresses[0]
			if (activeSafe?.type !== 'safe') throw new Error('Expected a Safe fixture')
			const contactWithSafeAddress = { type: 'contact', name: 'Safe address contact', address: activeSafe.address, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true } as const

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createNonSafeStackHomePageUpdate(23, 2, 'Non-Safe stack tab')) }, {}, () => undefined)
			})

			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), false)
			assert.equal(dom.document.body.textContent?.includes('Select simulation mode or a Gnosis Safe to view a transaction stack.'), true)

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, { ...update, popupRefreshGeneration: 3, data: { ...update.data, activeAddresses: [contactWithSafeAddress, { ...activeSafe, safeSimulationSignerAddress: undefined }], hasSafeTransactionsToExport: false } }) }, {}, () => undefined)
			})

			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
			assert.notEqual(getButtonByText(dom.document.body, 'Export').getAttribute?.('disabled'), null)
			assert.equal(getButtonByText(dom.document.body, 'Export').getAttribute?.('title'), 'There are no Gnosis Safe proposals to export on the selected chain.')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, { ...update, popupRefreshGeneration: 4, data: { ...update.data, tabState: { ...update.data.tabState, signerAccounts: [0x9999999999999999999999999999999999999999n] } } }) }, {}, () => undefined)
			})

			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer switches between mutually exclusive Safe and simulation controls', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createStackHomePageUpdate(22, 1, 'Stack tab')) }, {}, () => undefined)
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), false)

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, createSimulationStackHomePageUpdate(22, 2, 'Simulation stack tab')) }, {}, () => undefined)
			})
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Export simulation stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
		} finally {
			dom.restore()
		}
	})

	test('popup displays shared pending work and ignores an older busy status after completion', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener, sentMessages } = installBrowserMock()
		try {
			await act(() => { render(h(App, {}), dom.document.body) })
			await act(() => { listener({ role: 'all', ...serialize(UpdateHomePage, createSimulationStackHomePageUpdate(25, 1, 'Popup')) }, {}, () => undefined) })
			assert.ok(sentMessages.some(message => PopupMessage.safeParse(message).success && typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestSettingsChangeStatus'))
			const status = async (revision: number, operation: 'rpc' | undefined) => await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsChangeStatus', data: { revision, operation } }), {}, () => undefined)
			})
			await status(10, 'rpc')
			assert.ok(dom.document.body.textContent.includes('Changing network. Check your wallet'))
			assert.equal(String(getButtonByText(dom.document.body, 'Change').getAttribute?.('disabled')), 'true')
			await status(11, undefined)
			await status(10, 'rpc')
			assert.equal(dom.document.body.textContent.includes('Changing network. Check your wallet'), false)
			assert.equal(getButtonByText(dom.document.body, 'Change').getAttribute?.('disabled'), undefined)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('signer selection reveals the current wallet account before permission work finishes', async () => {
		const dom = installDomMock()
		let finishChange: (reply: unknown) => void = () => undefined
		const changeReply = new Promise<unknown>((resolve) => { finishChange = resolve })
		const { dispatchMessage: listener } = installBrowserMock((message) => {
			const parsed = PopupMessage.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_changeActiveAddress' ? changeReply : undefined
		})
		function Harness() {
			const home = useLiveSimulationHomeData({ answerMainPopupOpen: true, answerSimulationDataConsumerOpen: true, requestFreshHomeDataOnMount: false })
			const changes = usePopupSettingsChanges(home)
			return h('div', {}, [
				h('button', { onClick: () => changes.setActiveAddressAndInformAboutIt('signer') }, 'Select signer'),
				h('span', {}, `${home.displayedSigningAddress.value}:${changes.isActiveAddressChanging.value}:${changes.isActiveAddressChangePending.value}`),
			])
		}
		try {
			await act(() => { render(h(Harness, {}), dom.document.body) })
			const initial = createStackHomePageUpdate(25, 1, 'Signing popup')
			await act(() => { listener({ role: 'all', ...serialize(UpdateHomePage, initial) }, {}, () => undefined) })
			// Start the request without awaiting its deliberately delayed permission-work reply.
			await act(() => { void clickElement(getButtonByText(dom.document.body, 'Select signer')) })
			assert.ok(dom.document.body.textContent.includes(':true:true'))
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: { ...initial.data.settings, activeSigningSafeAddress: undefined }, popupRefreshGeneration: 2 }), {}, () => undefined)
			})
			assert.ok(dom.document.body.textContent.includes(`${initial.data.tabState.activeSigningAddress}:false:true`))
			// A newer authoritative selection must survive the original request's eventual reply.
			await act(() => { listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 3 }), {}, () => undefined) })
			await act(async () => {
				finishChange({ type: 'ChangeActiveAddressReply', ok: true })
				await changeReply
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.ok(dom.document.body.textContent.includes(`${initial.data.settings.activeSigningSafeAddress}:false:false`))
		} finally {
			finishChange(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('popup reveals the committed wallet before the address-change reply and preserves later settings', async () => {
		const dom = installDomMock()
		let finishChange: (reply: unknown) => void = () => undefined
		const changeReply = new Promise<unknown>((resolve) => { finishChange = resolve })
		let changeRequested = false
		const { dispatchMessage: listener } = installBrowserMock((message) => {
			const parsed = PopupMessage.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_changeActiveAddress') {
				changeRequested = true
				return changeReply
			}
			return undefined
		})
		try {
			await act(() => { render(h(App, {}), dom.document.body) })
			const initial = createSimulationStackHomePageUpdate(25, 1, 'Simulation popup')
			const nextEntry = createRichAddressEntry(2n, 'Next wallet')
			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, { ...initial, data: { ...initial.data, activeAddresses: [...initial.data.activeAddresses, nextEntry] } }) }, {}, () => undefined)
			})
			await act(async () => {
				await clickElement(getButtonByText(dom.document.body, 'Change'))
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			await act(async () => { await import('../../app/ts/components/pages/ChangeActiveAddress.js') })
			const nextCard = collectElements(dom.document.body, 'div').find((element) => element.getAttribute?.('class') === 'card hoverable' && element.textContent?.includes('Next wallet'))
			if (nextCard === undefined) throw new Error('Expected the next wallet in the address picker')
			await act(async () => { await clickElement(nextCard) })
			assert.ok(changeRequested)
			const addressRow = () => collectElements(dom.document.body, 'div').find((element) => hasClass(element, 'active-address-row'))
			assert.equal(addressRow()?.getAttribute?.('aria-label'), 'Switching active address')
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 2 }), {}, () => undefined)
			})
			assert.equal(addressRow()?.getAttribute?.('aria-label'), 'Switching active address')
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: { ...initial.data.settings, activeSimulationAddress: 2n }, popupRefreshGeneration: 3 }), {}, () => undefined)
			})
			assert.equal(addressRow()?.textContent?.includes('Next wallet'), true)
			assert.equal(String(getButtonByText(dom.document.body, 'Change').getAttribute?.('disabled')), 'true')
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 4 }), {}, () => undefined)
			})
			await act(async () => {
				finishChange({ type: 'ChangeActiveAddressReply', ok: true })
				await changeReply
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.equal(addressRow()?.textContent?.includes('Simulation address'), true)
			assert.equal(getButtonByText(dom.document.body, 'Change').getAttribute?.('disabled'), undefined)
		} finally {
			finishChange(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('reveals committed address settings while withholding stale simulation and older settings', async () => {
		const dom = installDomMock()
		let finishRefresh: (reply: unknown) => void = () => undefined
		const refresh = new Promise<unknown>((resolve) => { finishRefresh = resolve })
		const { dispatchMessage: listener } = installBrowserMock((message) => (
			typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestCompleteVisualizedSimulation'
				? refresh : undefined
		))
		try {
			await act(() => { render(h(AddressSelectionProbe, {}), dom.document.body) })
			const initial = createSimulationStackHomePageUpdate(25, 1, 'Simulation popup')
			await act(() => { listener({ role: 'all', ...serialize(UpdateHomePage, initial) }, {}, () => undefined) })
			const settings = { ...initial.data.settings, activeSimulationAddress: 2n }
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration: 3 }), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent, '2/passthrough/loading')
			await act(() => {
				listener(serialize(MessageToPopup, { role: 'all', method: 'popup_settingsUpdated', data: initial.data.settings, popupRefreshGeneration: 2 }), {}, () => undefined)
				listener({ role: 'all', ...serialize(UpdateHomePage, initial) }, {}, () => undefined)
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(initial.data.visualizedSimulatorState)), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent, '2/passthrough/loading')
			await act(async () => {
				finishRefresh({ method: 'popup_requestCompleteVisualizedSimulation', visualizedSimulatorState: serialize(CompleteVisualizedSimulation, createSimulatedCompleteVisualizedSimulation(settings)) })
				await refresh
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
			assert.equal(dom.document.body.textContent, '2/simulated/done')
		} finally {
			finishRefresh(undefined)
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('open stack visualizer switches modes immediately when settings change', async () => {
		const dom = installDomMock()
		let resolveVisualizationRefresh: ((reply: unknown) => void) | undefined
		const visualizationRefresh = new Promise<unknown>((resolve) => { resolveVisualizationRefresh = resolve })
		const { dispatchMessage: listener } = installBrowserMock((message) => (
			typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestCompleteVisualizedSimulation'
				? visualizationRefresh
				: undefined
		))
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const safeUpdate = createStackHomePageUpdate(25, 1, 'Safe stack tab')

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, safeUpdate) }, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)

			await act(() => {
				listener(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: { ...safeUpdate.data.settings, simulationMode: true },
				}), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Simulation Stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), false)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), false)

			await act(() => {
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(safeUpdate.data.visualizedSimulatorState)), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), false)

			await act(() => {
				listener({
					role: 'all',
					...serialize(UpdateHomePage, {
						...safeUpdate,
						homeDataSource: 'cached',
						popupRefreshGeneration: 3,
						data: {
							...safeUpdate.data,
							settings: { ...safeUpdate.data.settings, simulationMode: true },
						},
					}),
				}, {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Simulation Stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), false)

			await act(async () => {
				resolveVisualizationRefresh?.(undefined)
				await visualizationRefresh
				await Promise.resolve()
			})
			await act(() => {
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation({
					...safeUpdate.data.settings,
					simulationMode: true,
				}))), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)

			await act(() => {
				listener(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 4,
					data: safeUpdate.data.settings,
				}), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Simulation Stack'), false)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import Gnosis Safe stack'), true)
			assert.equal(hasButtonWithAriaLabel(dom.document.body, 'Import simulation stack'), false)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer releases its refresh barrier when the active Safe changes independently', async () => {
		const dom = installDomMock()
		let resolveVisualizationRefresh: ((reply: unknown) => void) | undefined
		const visualizationRefresh = new Promise<unknown>((resolve) => { resolveVisualizationRefresh = resolve })
		const { dispatchMessage: listener } = installBrowserMock((message) => (
			typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestCompleteVisualizedSimulation'
				? visualizationRefresh
				: undefined
		))
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})
			const simulationUpdate = createSimulationStackHomePageUpdate(27, 1, 'Simulation stack tab')
			const safeSettings = createStackHomePageUpdate(27, 2, 'Safe stack tab').data.settings

			await act(() => {
				listener({ role: 'all', ...serialize(UpdateHomePage, simulationUpdate) }, {}, () => undefined)
				listener(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 2,
					data: safeSettings,
				}), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), false)

			await act(() => {
				listener(serialize(MessageToPopup, {
					role: 'all',
					method: 'popup_activeSigningAddressChanged',
					data: {
						tabId: 27,
						activeSigningAddress: 0x1000000000000000000000000000000000000001n,
						activeSigningSafeAddress: 0x4000000000000000000000000000000000000004n,
					},
				}), {}, () => undefined)
			})
			await act(async () => {
				resolveVisualizationRefresh?.(undefined)
				await visualizationRefresh
				await Promise.resolve()
			})
			await act(() => {
				listener(serialize(MessageToPopup, createSimulationStateChangedMessage(createSimulatedCompleteVisualizedSimulation({
					...safeSettings,
					activeSigningSafeAddress: 0x4000000000000000000000000000000000000004n,
				}))), {}, () => undefined)
			})
			assert.equal(dom.document.body.textContent?.includes('Gnosis Safe Stack'), true)
			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer transaction cards collapse and reopen independently', async () => {
		const dom = installDomMock()
		const { dispatchMessage: listener } = installBrowserMock()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

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
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), false)

			await act(async () => {
				await clickElement(secondHeader)
			})
			assert.equal(String(firstHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(String(secondHeader.getAttribute?.('aria-expanded')), 'false')
			assert.equal(countTextOccurrences(dom.document.body.textContent ?? '', 'Original request'), 0)
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), false)

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
		const { dispatchMessage: listener } = installBrowserMock()
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
		const { dispatchMessage: listener } = installBrowserMock()
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
		const { dispatchMessage: listener } = installBrowserMock()
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
		const { dispatchMessage: listener } = installBrowserMock()
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

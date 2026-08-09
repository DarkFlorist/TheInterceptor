import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import { installDomMock } from './domMock.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import type { ContactEntry, SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { HomeParams, RpcConnectionStatus, TabState } from '../../app/ts/types/user-interface-types.js'
import { PASSTHROUGH_STATE, toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, PreSimulationTransaction, ResolvedSimulationResults, SignedMessageTransaction, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'

const ACTIVE_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n
const SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n
const SAFE_SIGNER_ADDRESS = 0x4000000000000000000000000000000000000004n
const OTHER_SIGNER_ADDRESS = 0x5000000000000000000000000000000000000005n
const homeSource = await Bun.file(new URL('../../app/ts/components/pages/Home.tsx', import.meta.url)).text()

const activeAddressEntry: ContactEntry = {
	type: 'contact',
	name: 'Active Address',
	address: ACTIVE_ADDRESS,
	entrySource: 'User',
	useAsActiveAddress: true,
	askForAddressAccess: true,
}

const recipientEntry: ContactEntry = {
	type: 'contact',
	name: 'Recipient',
	address: RECIPIENT_ADDRESS,
	entrySource: 'OnChain',
}

const safeEntry: SafeEntry = {
	type: 'safe',
	name: 'Treasury Safe',
	address: SAFE_ADDRESS,
	safeSimulationSignerAddress: SAFE_SIGNER_ADDRESS,
	safeSignerAddresses: [SAFE_SIGNER_ADDRESS, OTHER_SIGNER_ADDRESS],
	chainId: 1n,
	entrySource: 'User',
	useAsActiveAddress: true,
}

const rpcNetwork: RpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const ZERO_BLOCK_TIME_MANIPULATION: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }

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

const makePreSimulationTransaction = (): PreSimulationTransaction => ({
	signedTransaction: mockSignTransaction({
		type: '1559',
		from: ACTIVE_ADDRESS,
		to: RECIPIENT_ADDRESS,
		value: 0n,
		input: new Uint8Array(),
		nonce: 0n,
		gas: 21_000n,
		chainId: 1n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
	}),
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array() }] },
	transactionIdentifier: 1n,
})

const makeSignedMessageTransaction = (): SignedMessageTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	fakeSignedFor: ACTIVE_ADDRESS,
	originalRequestParameters: { method: 'personal_sign', params: ['0x68656c6c6f', ACTIVE_ADDRESS] },
	request: { method: 'personal_sign', params: ['0x68656c6c6f', ACTIVE_ADDRESS] },
	simulationMode: true,
	messageIdentifier: 77n,
})

const makeSimulatedTransaction = (): SimulatedAndVisualizedTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier: 1n,
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array() }] },
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 0n,
	realizedGasPrice: 1n,
	quarantine: false,
	quarantineReasons: [],
	transactionStatus: 'Transaction Succeeded',
	transaction: {
		from: activeAddressEntry,
		to: recipientEntry,
		rpcNetwork,
		type: '1559',
		nonce: 0n,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		gas: 21_000n,
		value: 0n,
		input: new Uint8Array(),
		hash: 1n,
	},
	events: [],
})

const createSimulationResults = (): SimulationAndVisualisationResults => ({
	blockNumber: 100n,
	blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
	simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
	simulationStateInput: [{
		stateOverrides: {},
		transactions: [makePreSimulationTransaction()],
		signedMessages: [],
		blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		simulateWithZeroBaseFee: false,
	}],
	addressBookEntries: [activeAddressEntry, recipientEntry],
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [{
			simulatedAndVisualizedTransactions: [makeSimulatedTransaction()],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		}],
	},
	rpcNetwork,
	tokenPriceEstimates: [],
	namedTokenIds: [],
})

const createEmptySimulationResults = (): SimulationAndVisualisationResults => ({
	...createSimulationResults(),
	simulationStateInput: [],
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [],
	},
})

const createPendingSimulationResults = (): SimulationAndVisualisationResults => ({
	...createSimulationResults(),
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [{
			simulatedAndVisualizedTransactions: [],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		}],
	},
})

const createPendingSignedMessageSimulationResults = (): SimulationAndVisualisationResults => ({
	...createSimulationResults(),
	simulationStateInput: [{
		stateOverrides: {},
		transactions: [],
		signedMessages: [makeSignedMessageTransaction()],
		blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		simulateWithZeroBaseFee: false,
	}],
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [{
			simulatedAndVisualizedTransactions: [],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		}],
	},
})

function createHomeParams(overrides: Partial<HomeParams> = {}): HomeParams {
	return {
		changeActiveAddress: () => undefined,
		makeCurrentAddressRich: new Signal(false),
		activeAddresses: new Signal([activeAddressEntry]),
		tabState: new Signal<TabState | undefined>(undefined),
		activeSimulationAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
		activeSigningAddress: new Signal<bigint | undefined>(undefined),
		useSignersAddressAsActiveAddress: new Signal(false),
		simVisResults: new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults())),
		rpcNetwork: new Signal(rpcNetwork),
		setActiveRpcAndInformAboutIt: () => undefined,
		simulationMode: new Signal(true),
		tabIconDetails: new Signal({ icon: ICON_SIMULATING, iconReason: 'Simulating transactions.' }),
		currentBlockNumber: new Signal<bigint | undefined>(101n),
		renameAddressCallBack: () => undefined,
		editEnsNamedHashCallBack: () => undefined,
		rpcConnectionStatus: new Signal<RpcConnectionStatus>(undefined),
		rpcEntries: new Signal([rpcNetwork]),
		simulationUpdatingState: new Signal<'done' | 'updating' | 'failed' | undefined>('done'),
		simulationResultState: new Signal<'done' | 'invalid' | 'corrupted' | undefined>('done'),
		interceptorDisabled: new Signal(false),
		preSimulationBlockTimeManipulation: new Signal<BlockTimeManipulation | undefined>(undefined),
		fixedAddressRichList: new Signal<readonly EnrichedRichListElement[]>([]),
		numberOfAddressesMadeRich: new Signal(0),
		isInitialHomeDataLoaded: new Signal(true),
		isFreshHomeDataLoaded: new Signal(true),
		...overrides,
	}
}

type TestDomNode = {
	readonly tagName?: string
	readonly parentNode?: TestDomNode | null
	readonly childNodes?: readonly TestDomNode[]
	readonly textContent?: string | null
	readonly checked?: boolean
	readonly l?: Record<string, (event: unknown) => unknown>
	readonly getAttribute?: (name: string) => string | null
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

async function keyDownElement(element: { l?: Record<string, (event: unknown) => unknown> }, event: unknown) {
	const keyDownHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('KeyDown'))?.[1]
	if (keyDownHandler === undefined) throw new Error('Expected keydown handler')
	await keyDownHandler(event)
}

function getButtonByText(root: TestDomNode, text: string) {
	const button = collectElements(root, 'button').find((button) => button.textContent?.replace(/\s+/g, ' ').trim() === text)
	if (button === undefined) throw new Error(`Expected button with text "${ text }"`)
	return button
}

function getButtonByAriaLabel(root: TestDomNode, ariaLabel: string) {
	const button = collectElements(root, 'button').find((button) => button.getAttribute?.('aria-label') === ariaLabel)
	if (button === undefined) throw new Error(`Expected button with aria-label "${ ariaLabel }"`)
	return button
}

function getHeaderContainingText(root: TestDomNode, text: string) {
	const header = collectElements(root, 'header').find((header) => header.textContent?.includes(text))
	if (header === undefined) throw new Error(`Expected header containing text "${ text }"`)
	return header
}

function getAncestor(node: TestDomNode, tagName: string) {
	let currentNode = node.parentNode
	while (currentNode !== undefined && currentNode !== null) {
		if (currentNode.tagName === tagName.toUpperCase()) return currentNode
		currentNode = currentNode.parentNode
	}
	throw new Error(`Expected ancestor ${ tagName }`)
}

function getButtonInTimePicker(root: TestDomNode, timePickerLabel: string, buttonText: string) {
	const timePickerLabelElement = collectElements(root, 'p').find((element) => element.textContent?.replace(/\s+/g, ' ').trim() === timePickerLabel)
	if (timePickerLabelElement?.parentNode === undefined || timePickerLabelElement.parentNode === null) throw new Error(`Expected time picker label "${ timePickerLabel }"`)
	return getButtonByText(timePickerLabelElement.parentNode, buttonText)
}

function installBrowserMock(replyToMessage?: (message: unknown) => unknown) {
	const previousBrowser = globalThis.browser
	const sentMessages: unknown[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					return replyToMessage?.(message)
				},
			},
		},
	})
	return {
		sentMessages,
		restore() {
			globalThis.browser = previousBrowser
		},
	}
}

function installCloseMock() {
	const previousClose = globalThis.close
	let closeCount = 0
	Object.defineProperty(globalThis, 'close', {
		configurable: true,
		writable: true,
		value: () => {
			closeCount += 1
		},
	})
	return {
		get closeCount() {
			return closeCount
		},
		restore() {
			globalThis.close = previousClose
		},
	}
}

function hasMethod(message: unknown, method: string) {
	return typeof message === 'object' && message !== null && 'method' in message && message.method === method
}

function getMessageWithMethod(messages: readonly unknown[], method: string) {
	const message = messages.find((message) => hasMethod(message, method))
	if (message === undefined) throw new Error(`Expected message with method "${ method }"`)
	return message
}

describe('Home popup clear empty state', () => {
	test('shows a skeleton until initial simulation status is known', async () => {
		const dom = installDomMock()
		const simulationUpdatingState = new Signal<'done' | 'updating' | 'failed' | undefined>(undefined)
		const simulationResultState = new Signal<'done' | 'invalid' | 'corrupted' | undefined>(undefined)
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults: new Signal(PASSTHROUGH_STATE),
					simulationUpdatingState,
					simulationResultState,
				})), dom.document.body)
			})

			const loadingState = [...collectElements(dom.document.body, 'div'), ...collectElements(dom.document.body, 'section')]
				.find((element) => element.getAttribute?.('aria-label') === 'Loading current simulation state')
			assert.notEqual(loadingState, undefined)
			assert.notEqual(collectElements(loadingState, 'div').find((element) => element.getAttribute?.('class')?.split(/\s+/).includes('simulation-results-header')), undefined)
			assert.equal(collectElements(dom.document.body, 'svg').find((element) => element.getAttribute?.('class') === 'spinner'), undefined)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)

			await act(() => {
				simulationUpdatingState.value = 'done'
				simulationResultState.value = 'done'
			})

			const resolvedLoadingState = [...collectElements(dom.document.body, 'div'), ...collectElements(dom.document.body, 'section')]
				.find((element) => element.getAttribute?.('aria-label') === 'Loading current simulation state')
			assert.equal(resolvedLoadingState, undefined)
			assert.notEqual(collectElements(dom.document.body, 'div').find((element) => element.getAttribute?.('class')?.split(/\s+/).includes('simulation-results-header')), undefined)
			assert.equal(collectElements(dom.document.body, 'svg').find((element) => element.getAttribute?.('class') === 'spinner'), undefined)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), true)
		} finally {
			dom.restore()
		}
	})

	test('rerenders to the empty-state dino when simulation results are cleared', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('Simulation Outcome'), true)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)

			await act(() => {
				simVisResults.value = toResolvedSimulationResults(createEmptySimulationResults())
			})

			assert.equal(simVisResults.value.kind, 'simulated')
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), true)
			assert.equal(dom.document.body.textContent?.includes('Simulation Outcome'), false)
		} finally {
			dom.restore()
		}
	})

	test('shows rich-only simulation state instead of the empty-state dino', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults,
					numberOfAddressesMadeRich: new Signal(2),
				})), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('opens the simulation stack from the rich-only state card', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					simVisResults,
					numberOfAddressesMadeRich: new Signal(2),
				})), dom.document.body)
			})

			const richHeader = getHeaderContainingText(dom.document.body, 'Simply making 2 addresses rich')
			assert.equal(richHeader.getAttribute?.('role'), 'button')
			assert.equal(richHeader.getAttribute?.('aria-label'), 'Open rich address state in the full simulation stack')

			await act(async () => {
				await clickElement(richHeader)
			})

			assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_openSimulationStack'), { method: 'popup_openSimulationStack' })
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			closeMock.restore()
		}
	})

	test('shows title-only stack cards while keeping per-transaction delay controls', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('Pending transaction'), true)
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), true)
			assert.equal(dom.document.body.textContent?.includes('Original request'), false)
			assert.equal(dom.document.body.textContent?.includes('Transaction Input'), false)
		} finally {
			dom.restore()
		}
	})

		test('opens the simulation stack at a title-only transaction header', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			await act(async () => {
				await clickElement(getHeaderContainingText(dom.document.body, 'Pending transaction'))
			})

			assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_openSimulationStack'), {
				method: 'popup_openSimulationStack',
				data: { type: 'Transaction', transactionIdentifier: '0x1' },
			})
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			closeMock.restore()
			}
		})

		test('opens the simulation stack from a title-only transaction header with Enter', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
			const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSimulationResults()))
			try {
				await act(() => {
					render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
				})

				const header = getHeaderContainingText(dom.document.body, 'Pending transaction')
				let preventDefaultCalled = false
				await act(async () => {
					await keyDownElement(header, {
						key: 'Enter',
						target: header,
						currentTarget: header,
						preventDefault() {
							preventDefaultCalled = true
						},
					})
				})

				assert.equal(preventDefaultCalled, true)
				assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_openSimulationStack'), {
					method: 'popup_openSimulationStack',
					data: { type: 'Transaction', transactionIdentifier: '0x1' },
				})
				assert.equal(closeMock.closeCount, 1)
			} finally {
				render(null, dom.document.body)
				dom.restore()
				browserMock.restore()
				closeMock.restore()
			}
		})

		test('opens the simulation stack from a title-only signature header with Space', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
			const closeMock = installCloseMock()
			const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSignedMessageSimulationResults()))
			try {
				await act(() => {
					render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
				})

				const header = getHeaderContainingText(dom.document.body, 'Pending signature')
				let preventDefaultCalled = false
				await act(async () => {
					await keyDownElement(header, {
						key: ' ',
						target: header,
						currentTarget: header,
						preventDefault() {
							preventDefaultCalled = true
						},
					})
				})

				assert.equal(preventDefaultCalled, true)
				assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_openSimulationStack'), {
					method: 'popup_openSimulationStack',
					data: { type: 'Message', messageIdentifier: '0x4d' },
				})
				assert.equal(closeMock.closeCount, 1)
			} finally {
				render(null, dom.document.body)
				dom.restore()
				browserMock.restore()
				closeMock.restore()
			}
		})

		test('does not open the simulation stack from bubbled remove-button key events', async () => {
			const dom = installDomMock()
			const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			const removeButton = getButtonByAriaLabel(dom.document.body, 'remove')
			const header = getAncestor(removeButton, 'header')
			let preventDefaultCalled = false

			await act(async () => {
				await keyDownElement(header, {
					key: 'Enter',
					target: removeButton,
					currentTarget: header,
					preventDefault() {
						preventDefaultCalled = true
					},
				})
			})

			assert.equal(preventDefaultCalled, false)
			assert.equal(browserMock.sentMessages.some((message) => hasMethod(message, 'popup_openSimulationStack')), false)

			await act(async () => {
				await clickElement(removeButton)
			})

			assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_removeTransactionOrSignedMessage'), {
				method: 'popup_removeTransactionOrSignedMessage',
				data: { type: 'Transaction', transactionIdentifier: '0x1' },
			})
			assert.equal(browserMock.sentMessages.some((message) => hasMethod(message, 'popup_openSimulationStack')), false)
			assert.equal(closeMock.closeCount, 0)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			closeMock.restore()
		}
	})

	test('commits title-only signed-message delay controls with the message identifier', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createPendingSignedMessageSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('Pending signature'), true)
			assert.equal(dom.document.body.textContent?.includes('Simulate delay'), true)
			assert.equal(dom.document.body.textContent?.includes('Signature request'), false)
			assert.equal(dom.document.body.textContent?.includes('Raw request'), false)

			await act(async () => {
				await clickElement(getButtonInTimePicker(dom.document.body, 'Simulate delay', 'For'))
			})
			await act(async () => {
				await clickElement(getButtonInTimePicker(dom.document.body, 'Simulate delay', 'Commit'))
			})

			assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_setTransactionOrMessageBlockTimeManipulator'), {
				method: 'popup_setTransactionOrMessageBlockTimeManipulator',
				data: {
					transactionOrMessageIdentifier: { type: 'Message', messageIdentifier: '0x4d' },
					blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0xc', deltaUnit: 'Seconds' },
				},
			})
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
		}
	})

	test('opens the simulation stack view from the popup button', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const closeMock = installCloseMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({ simVisResults })), dom.document.body)
			})

			const viewStackButton = getButtonByText(dom.document.body, 'View stack details')
			assert.equal(viewStackButton.getAttribute?.('aria-label'), 'Open simulation stack details in a new tab')
			assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.replace(/\s+/g, ' ').trim() === 'Import'), false)
			assert.equal(dom.document.body.textContent?.includes('Export Simulation Stack'), false)

			await act(async () => {
				await clickElement(viewStackButton)
			})

			assert.deepStrictEqual(getMessageWithMethod(browserMock.sentMessages, 'popup_openSimulationStack'), { method: 'popup_openSimulationStack' })
			assert.equal(closeMock.closeCount, 1)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			closeMock.restore()
		}
	})

	test('treats a known signer account as connected even if the signerConnected flag is stale', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: false,
						signerName: 'MetaMask',
						signerAccounts: [ACTIVE_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIMULATING, iconReason: 'Connected through MetaMask.' },
						activeSigningAddress: ACTIVE_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(undefined),
					activeSigningAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
					useSignersAddressAsActiveAddress: new Signal(true),
					simVisResults,
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIMULATING, iconReason: 'Connected through MetaMask.' }),
				})), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('CONNECTED'), true)
			assert.equal(dom.document.body.textContent?.includes('NOT CONNECTED'), false)
		} finally {
			dom.restore()
		}
	})

	test('shows an unsaved signer address when it is active in simulation mode', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([activeAddressEntry]),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					useSignersAddressAsActiveAddress: new Signal(true),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent ?? ''
			assert.equal(popupText.includes('0x4000000000000000000000000000000000000004'), true)
			assert.equal(popupText.includes('No address found'), false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

test('shows the wallet-selected Safe owner without a signer selector in signing mode', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent ?? ''
			assert.equal(popupText.includes('Treasury Safe'), true)
			assert.equal(popupText.includes('0x3000000000000000000000000000000000000003'), true)
			assert.equal(popupText.includes('Interceptor verifies this account against the current Gnosis Safe owners when signing.'), true)
			assert.equal(popupText.includes('0x4000000000000000000000000000000000000004'), true)
			assert.equal(popupText.includes('0x5000000000000000000000000000000000000005'), false)
			assert.equal(collectElements(dom.document.body, 'input').filter((element) => element.getAttribute?.('name') === 'active-safe-signer').length, 0)
			const signerOptions = collectElements(dom.document.body, 'label').filter((element) =>
				element.getAttribute?.('class')?.includes('safe-signer-option') === true
			)
			assert.equal(signerOptions.length, 0)
			assert.equal(popupText.includes('CONNECTED'), true)
			assert.equal(popupText.includes('NOT CONNECTED'), false)
			assert.equal(popupText.includes('Interceptor verifies this account against the current Gnosis Safe owners when signing.'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('disables the Gnosis Safe signer connect button and shows progress while MetaMask is opening', async () => {
		const dom = installDomMock()
		const immediateRequestAnimationFrame = globalThis.requestAnimationFrame
		const animationFrames: FrameRequestCallback[] = []
		let resolveConnectRequest: (() => void) | undefined
		const connectRequest = new Promise<void>((resolve) => { resolveConnectRequest = resolve })
		const browserMock = installBrowserMock((message) =>
			hasMethod(message, 'popup_requestAccountsFromSigner')
				? connectRequest
				: undefined
		)
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: undefined,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(undefined),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			globalThis.requestAnimationFrame = (callback) => {
				animationFrames.push(callback)
				return animationFrames.length
			}
			const connectButton = getButtonByText(dom.document.body, 'Connect to MetaMask')
			await act(async () => {
				await clickElement(connectButton)
			})

			const pendingButton = getButtonByText(dom.document.body, 'Connecting to MetaMask')
			assert.notEqual(pendingButton.getAttribute?.('disabled'), null)
			assert.equal(pendingButton.getAttribute?.('aria-busy'), true)
			assert.notEqual(collectElements(pendingButton, 'svg').find((element) => element.getAttribute?.('class') === 'spinner'), undefined)
			assert.equal(browserMock.sentMessages.some((message) => hasMethod(message, 'popup_requestAccountsFromSigner')), false)

			await act(async () => {
				for (const callback of animationFrames.splice(0)) callback(0)
				await Promise.resolve()
			})
			assert.equal(browserMock.sentMessages.some((message) => hasMethod(message, 'popup_requestAccountsFromSigner')), false)
			await act(async () => {
				for (const callback of animationFrames.splice(0)) callback(0)
				await Promise.resolve()
			})
			assert.equal(browserMock.sentMessages.filter((message) => hasMethod(message, 'popup_requestAccountsFromSigner')).length, 1)

			if (resolveConnectRequest === undefined) throw new Error('Missing MetaMask connect resolver')
			resolveConnectRequest()
			await act(async () => {
				await connectRequest
				await new Promise((resolve) => setTimeout(resolve, 0))
			})
		} finally {
			render(null, dom.document.body)
			globalThis.requestAnimationFrame = immediateRequestAnimationFrame
			dom.restore()
			browserMock.restore()
		}
	})

test('changes the Safe simulation signer from the popup in simulation mode', async () => {
		const dom = installDomMock()
		let resolveSelection: ((reply: { type: 'SetSafeSimulationSignerReply', ok: true }) => void) | undefined
		const selectionReply = new Promise<{ type: 'SetSafeSimulationSignerReply', ok: true }>((resolve) => { resolveSelection = resolve })
		const browserMock = installBrowserMock((message) =>
			hasMethod(message, 'popup_setSafeSimulationSigner')
				? selectionReply
				: undefined
		)
		const activeAddresses = new Signal([safeEntry])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
				simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const otherSignerOption = collectElements(dom.document.body, 'label').find((element) =>
				collectElements(element, 'input').some((input) => input.getAttribute?.('aria-label') === 'Simulate as Gnosis Safe owner 0x5000000000000000000000000000000000000005')
			)
			if (otherSignerOption === undefined) throw new Error('Missing alternate Safe signer option')
			const otherSignerIdentity = collectElements(otherSignerOption, 'span').find((element) => element.getAttribute?.('class') === 'safe-signer-option-address')
			if (otherSignerIdentity?.l === undefined) throw new Error('Missing alternate Safe signer identity')
			const clickHandler = Object.entries(otherSignerIdentity.l).find(([key]) => key.startsWith('Click'))?.[1]
			if (clickHandler === undefined) throw new Error('Missing alternate Safe signer identity click handler')
			let defaultPrevented = false
			let propagationStopped = false
			await act(async () => {
				await clickHandler({
					currentTarget: otherSignerIdentity,
					preventDefault() { defaultPrevented = true },
					stopPropagation() { propagationStopped = true },
				})
			})
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			const optimisticallySelectedRadios = collectElements(dom.document.body, 'input').filter((element) =>
				element.getAttribute?.('name') === 'active-safe-signer'
			)
			assert.equal(optimisticallySelectedRadios[0]?.checked === true || (optimisticallySelectedRadios[0]?.getAttribute?.('checked') ?? null) !== null, false)
			assert.equal(optimisticallySelectedRadios[1]?.checked === true || (optimisticallySelectedRadios[1]?.getAttribute?.('checked') ?? null) !== null, true)
			await act(async () => {
				await clickHandler({
					currentTarget: otherSignerIdentity,
					preventDefault() { return undefined },
					stopPropagation() { return undefined },
				})
			})
			assert.equal(browserMock.sentMessages.filter((message) => hasMethod(message, 'popup_setSafeSimulationSigner')).length, 1)
			if (resolveSelection === undefined) throw new Error('Missing Safe signer selection resolver')
			resolveSelection({ type: 'SetSafeSimulationSignerReply', ok: true })
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			const updateMessage = getMessageWithMethod(browserMock.sentMessages, 'popup_setSafeSimulationSigner')
			if (typeof updateMessage !== 'object' || updateMessage === null || !('data' in updateMessage)) throw new Error('Missing Safe signer update message')
			const updatedSafe = updateMessage.data
			if (typeof updatedSafe !== 'object' || updatedSafe === null || !('safeSimulationSignerAddress' in updatedSafe)) throw new Error('Missing Safe simulation signer')
			assert.equal(defaultPrevented, true)
			assert.equal(propagationStopped, true)
			assert.equal(updatedSafe.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			assert.equal(updatedSafe.safeAddress, SAFE_ADDRESS)
			assert.equal(updatedSafe.chainId, 1n)
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)
			const signerRadios = collectElements(dom.document.body, 'input').filter((element) =>
				element.getAttribute?.('name') === 'active-safe-signer'
			)
			assert.deepEqual(signerRadios.map((radio) => radio.getAttribute?.('aria-label')), [
				'Simulate as Gnosis Safe owner 0x4000000000000000000000000000000000000004',
				'Simulate as Gnosis Safe owner 0x5000000000000000000000000000000000000005',
			])
			assert.equal(signerRadios[0]?.checked === true || (signerRadios[0]?.getAttribute?.('checked') ?? null) !== null, false)
			assert.equal(signerRadios[1]?.checked === true || (signerRadios[1]?.getAttribute?.('checked') ?? null) !== null, true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
		}
	})

test('rolls back only the simulation signer when optimistic persistence fails', async () => {
		const dom = installDomMock()
		let resolveSelection: ((reply: { type: 'SetSafeSimulationSignerReply', ok: false, message: string }) => void) | undefined
		const selectionReply = new Promise<{ type: 'SetSafeSimulationSignerReply', ok: false, message: string }>((resolve) => { resolveSelection = resolve })
		const browserMock = installBrowserMock((message) =>
			hasMethod(message, 'popup_setSafeSimulationSigner')
				? selectionReply
				: undefined
		)
		const activeAddresses = new Signal([safeEntry])
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses,
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
				simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const alternateSignerOption = collectElements(dom.document.body, 'label').find((element) =>
				collectElements(element, 'input').some((input) => input.getAttribute?.('aria-label') === 'Simulate as Gnosis Safe owner 0x5000000000000000000000000000000000000005')
			)
			const alternateSignerIdentity = alternateSignerOption === undefined
				? undefined
				: collectElements(alternateSignerOption, 'span').find((element) => element.getAttribute?.('class') === 'safe-signer-option-address')
			if (alternateSignerIdentity?.l === undefined) throw new Error('Missing alternate Safe signer identity')
			const clickHandler = Object.entries(alternateSignerIdentity.l).find(([key]) => key.startsWith('Click'))?.[1]
			if (clickHandler === undefined) throw new Error('Missing alternate Safe signer identity click handler')
			await act(async () => {
				await clickHandler({
					currentTarget: alternateSignerIdentity,
					preventDefault() { return undefined },
					stopPropagation() { return undefined },
				})
			})
			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, OTHER_SIGNER_ADDRESS)

			activeAddresses.value = [{ ...safeEntry, name: 'Refreshed Treasury Safe', safeSimulationSignerAddress: OTHER_SIGNER_ADDRESS }]
			if (resolveSelection === undefined) throw new Error('Missing Safe signer selection resolver')
			resolveSelection({ type: 'SetSafeSimulationSignerReply', ok: false, message: 'Signer persistence failed.' })
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			assert.equal(activeAddresses.value[0]?.safeSimulationSignerAddress, SAFE_SIGNER_ADDRESS)
			assert.equal(activeAddresses.value[0]?.name, 'Refreshed Treasury Safe')
			assert.equal((dom.document.body.textContent ?? '').includes('Signer persistence failed.'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
		}
	})

test('copies and edits a Safe simulation signer without changing the selection', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		const clipboardMock = installClipboardMock()
		let editedSignerAddress: bigint | undefined
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
						signerAccounts: [SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
						activeSigningAddress: SAFE_SIGNER_ADDRESS,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(SAFE_SIGNER_ADDRESS),
				simulationMode: new Signal(true),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
					renameAddressCallBack: (entry) => { editedSignerAddress = entry.address },
				})), dom.document.body)
			})

			const signerOption = collectElements(dom.document.body, 'label').find((element) =>
				element.getAttribute?.('class')?.includes('safe-signer-option') === true
			)
			if (signerOption === undefined) throw new Error('Missing Safe signer option')
			const signerButtons = collectElements(signerOption, 'button')
			const copyButton = signerButtons.find((button) => button.textContent?.includes('copy') === true)
			const editButton = signerButtons.find((button) => button.textContent?.includes('edit') === true)
			if (copyButton?.l === undefined || editButton?.l === undefined) throw new Error('Missing Safe signer address actions')
			const copyHandler = Object.entries(copyButton.l).find(([key]) => key.startsWith('Click'))?.[1]
			const editHandler = Object.entries(editButton.l).find(([key]) => key.startsWith('Click'))?.[1]
			if (copyHandler === undefined || editHandler === undefined) throw new Error('Missing Safe signer address action handlers')

			let copyPropagationStopped = false
			await copyHandler({
				clientX: 0,
				clientY: 0,
				currentTarget: copyButton,
				stopPropagation() { copyPropagationStopped = true },
			})
			let editPropagationStopped = false
			await editHandler({
				currentTarget: editButton,
				stopPropagation() { editPropagationStopped = true },
			})

			assert.equal(copyPropagationStopped, true)
			assert.deepEqual(clipboardMock.copiedText, ['0x4000000000000000000000000000000000000004'])
			assert.equal(editPropagationStopped, true)
			assert.equal(editedSignerAddress, SAFE_SIGNER_ADDRESS)
			assert.equal(browserMock.sentMessages.some((message) => hasMethod(message, 'popup_setSafeSimulationSigner')), false)
			const signerRadios = collectElements(dom.document.body, 'input').filter((element) => element.getAttribute?.('name') === 'active-safe-signer')
			assert.equal(signerRadios[0]?.checked === true || (signerRadios[0]?.getAttribute?.('checked') ?? null) !== null, true)
			assert.equal(signerRadios[1]?.checked === true || (signerRadios[1]?.getAttribute?.('checked') ?? null) !== null, false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			clipboardMock.restore()
		}
	})

test('does not infer Safe ownership from cached owners in signing mode', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(Home, createHomeParams({
					activeAddresses: new Signal([safeEntry]),
					tabState: new Signal<TabState | undefined>({
						tabId: 1,
						website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
						signerConnected: true,
						signerName: 'MetaMask',
					signerAccounts: [0x6000000000000000000000000000000000000006n, SAFE_SIGNER_ADDRESS],
						signerAccountError: undefined,
						signerChain: 1n,
						tabIconDetails: { icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' },
					activeSigningAddress: 0x6000000000000000000000000000000000000006n,
					}),
					activeSimulationAddress: new Signal<bigint | undefined>(SAFE_ADDRESS),
				activeSigningAddress: new Signal<bigint | undefined>(0x6000000000000000000000000000000000000006n),
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIGNING, iconReason: 'Signing through MetaMask.' }),
				})), dom.document.body)
			})

			const popupText = dom.document.body.textContent ?? ''
			assert.equal(popupText.includes('Gnosis Safe signers'), false)
			assert.equal(popupText.includes('CONNECTED'), true)
			assert.equal(popupText.includes('NOT CONNECTED'), false)
			assert.equal(popupText.includes('MetaMask has 0x6000000000000000000000000000000000000006 selected. Interceptor verifies this account against the current Gnosis Safe owners when signing.'), true)
			const retrievalStatus = collectElements(dom.document.body, 'p').find((element) =>
				element.getAttribute?.('class') === 'popup-home-retrieval-status'
			)
			if (retrievalStatus === undefined) throw new Error('Missing aligned wallet retrieval status')
			assert.equal(collectElements(retrievalStatus, 'span').some((element) => element.getAttribute?.('class') === 'popup-home-retrieval-source'), true)
			assert.equal(collectElements(dom.document.body, 'p').some((element) =>
				element.getAttribute?.('class')?.includes('safe-signer-connection-message') === true
			), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('places the Gnosis Safe transaction copy action between stack details and clear', () => {
		const headerStart = homeSource.indexOf('function SimulationResultsHeader(')
		const headerEnd = homeSource.indexOf('function PopupVisualisation(', headerStart)
		const headerSource = homeSource.slice(headerStart, headerEnd)
		const viewPosition = headerSource.indexOf('<OpenSimulationStackButtonContent')
		const copyPosition = headerSource.indexOf('<CopySafeTransactionsButton')
		const clearPosition = headerSource.indexOf('<AsyncActionButton')

		assert.notEqual(viewPosition, -1)
		assert.notEqual(copyPosition, -1)
		assert.notEqual(clearPosition, -1)
		assert.equal(viewPosition < copyPosition && copyPosition < clearPosition, true)
	})
})

import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { FetchSimulationStack } from '../../app/ts/components/pages/FetchSimulationStack.js'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { retainPreviousVisualisation } from '../../app/ts/background/popupVisualisationLifecycle.js'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { PendingFetchSimulationStackRequestPromise } from '../../app/ts/types/user-interface-types.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown

const storageState: Record<string, unknown> = {}
const pageListeners: RuntimeMessageListener[] = []
const messageCounts = { simulationStatePublishes: 0, ethSimulateV1Requests: 0 }
let messagesInFlight = 0
// Requests a test deliberately leaves unanswered; they stay in flight without keeping the flow from settling.
let heldRequests = 0
let routeBackgroundRequest: ((message: unknown) => Promise<unknown>) | undefined

function getMessageMethod(message: unknown) {
	if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') return undefined
	return message.method
}

// Broadcasts from the background carry a role; the open-consumer probes are background requests that pages answer.
function isMessageToPages(message: unknown) {
	if (typeof message === 'object' && message !== null && 'role' in message) return true
	const method = getMessageMethod(message)
	return method === 'popup_isSimulationVisualizerOpen' || method === 'popup_isMainPopupWindowOpen'
}

function deliverToPages(message: unknown) {
	if (getMessageMethod(message) === 'popup_simulation_state_changed') messageCounts.simulationStatePublishes += 1
	let response: unknown
	for (const listener of [...pageListeners]) listener(message, {}, (reply?: unknown) => { response = reply })
	return response
}

function installBrowserMock() {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
				// Extension messaging crosses processes, so each hop is delivered in a later task.
				async sendMessage(message: unknown) {
					messagesInFlight += 1
					try {
						await new Promise((resolve) => setTimeout(resolve, 0))
						if (isMessageToPages(message)) return deliverToPages(message)
						return await routeBackgroundRequest?.(message)
					} finally {
						messagesInFlight -= 1
					}
				},
				onMessage: {
					addListener(listener: RuntimeMessageListener) { pageListeners.push(listener) },
					removeListener(listener: RuntimeMessageListener) {
						const index = pageListeners.indexOf(listener)
						if (index >= 0) pageListeners.splice(index, 1)
					},
				},
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
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
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })
}

installBrowserMock()

const [
	{ popupMessageHandler },
	{ updatePopupVisualisationIfNeeded },
	{ browserStorageLocalSet },
	{ getSettings },
	{ getLatestUnexpectedError, setFetchSimulationStackRequestPromise },
	{ EthereumClientService },
	{ TokenPriceService },
] = await Promise.all([
	import('../../app/ts/background/popupMessageRouting.js'),
	import('../../app/ts/background/popupVisualisationUpdater.js'),
	import('../../app/ts/utils/storageUtils.js'),
	import('../../app/ts/background/settings.js'),
	import('../../app/ts/background/storageVariables.js'),
	import('../../app/ts/simulation/services/EthereumClientService.js'),
	import('../../app/ts/simulation/services/priceEstimator.js'),
])

const rpcNetwork = {
	name: 'Refresh Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://refresh-loop.example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}
const simulationAddress = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const pendingFetchSimulationStackRequest: PendingFetchSimulationStackRequestPromise = {
	website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
	popupOrTabId: { type: 'popup', id: 41 },
	simulationOverlayEnabled: true,
	simulationStackVersion: '2.0.0',
	uniqueRequestIdentifier: { requestId: 7, requestSocket: { tabId: 3, connectionName: 5n } },
}

function getRpcResult(response: string): unknown {
	const parsed: unknown = JSON.parse(response)
	if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) throw new Error('Expected a JSON-RPC result fixture')
	return parsed.result
}

const latestBlock = getRpcResult(eth_getBlockByNumber_goerli_8443561_true)
const simulatedBlockFixture = (() => {
	const blocks = getRpcResult(eth_simulateV1_dummy_call_result)
	if (!Array.isArray(blocks) || typeof blocks[0] !== 'object' || blocks[0] === null) throw new Error('Expected an eth_simulateV1 block fixture')
	return { ...blocks[0], calls: [] }
})()

const requestHandler = {
	rpcUrl: rpcNetwork.httpsRpc,
	clearCache: () => undefined,
	getChainId: async () => rpcNetwork.chainId,
	async jsonRpcRequest(rpcRequest: EthereumJsonRpcRequest) {
		switch (rpcRequest.method) {
			case 'eth_getBlockByNumber': return latestBlock
			case 'eth_blockNumber': return '0x80d6a9'
			case 'eth_getCode': return '0x'
			case 'eth_simulateV1': {
				messageCounts.ethSimulateV1Requests += 1
				return rpcRequest.params[0].blockStateCalls.map(() => simulatedBlockFixture)
			}
			default: throw new Error(`Unexpected RPC request: ${ rpcRequest.method }`)
		}
	},
}
const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcNetwork)
const tokenPriceService = new TokenPriceService(ethereum, 60_000)
const simulationServicesOwner = {
	getCurrent: () => ({ ethereum, tokenPriceService }),
	reset: () => ({ ethereum, tokenPriceService }),
}

// Requests that reach the real background dispatcher. The live consumer's cached home-data requests neither simulate nor publish simulation state, so they stay unanswered here.
const BACKGROUND_SIMULATION_REQUESTS = new Set(['popup_readyAndListening', 'popup_requestCompleteVisualizedSimulation', 'popup_requestSimulationMetadata', 'popup_refreshSimulation'])

async function dispatchToBackground(message: unknown) {
	const method = getMessageMethod(message)
	if (method === undefined || !BACKGROUND_SIMULATION_REQUESTS.has(method)) return undefined
	return await popupMessageHandler(new Map(), simulationServicesOwner, message, await getSettings(), async () => undefined)
}

// Stands in for the home popup or simulation stack page: it answers the open-consumer probe and keeps each published state.
function LiveSimulationConsumer() {
	useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
		requestHomeDataOnSimulationStateChange: true,
	})
	return <p>live simulation consumer</p>
}

const MAX_SETTLE_TICKS = 200
// Every trigger in these tests converges after at most two publishes, so more than this means the refresh loop is running.
const REFRESH_LOOP_PUBLISH_LIMIT = 10

// A converging flow goes idle; the refresh loop keeps a message in flight, so stop waiting once it has clearly started.
async function settleMessageFlow() {
	let idleTicks = 0
	for (let tick = 0; tick < MAX_SETTLE_TICKS && idleTicks < 3 && messageCounts.simulationStatePublishes <= REFRESH_LOOP_PUBLISH_LIMIT; tick++) {
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
		idleTicks = messagesInFlight === heldRequests ? idleTicks + 1 : 0
	}
}

function resetMessageCounts() {
	messageCounts.simulationStatePublishes = 0
	messageCounts.ethSimulateV1Requests = 0
}

async function setUpSimulationModeWithOpenConsumer() {
	for (const key of Object.keys(storageState)) delete storageState[key]
	pageListeners.length = 0
	installBrowserMock()
	routeBackgroundRequest = dispatchToBackground
	await browserStorageLocalSet({
		activeRpcNetwork: rpcNetwork,
		simulationMode: true,
		independentActiveSimulationAddress: simulationAddress,
		makeCurrentAddressRich: true,
		interceptorTransactionStack: { operations: [] },
	})
	await setFetchSimulationStackRequestPromise(pendingFetchSimulationStackRequest)
	const dom = installDomMock()
	const consumerContainer = dom.document.createElement('div')
	const fetchSimulationStackContainer = dom.document.createElement('div')
	dom.document.body.appendChild(consumerContainer)
	dom.document.body.appendChild(fetchSimulationStackContainer)
	await act(() => { render(<LiveSimulationConsumer />, consumerContainer) })
	await settleMessageFlow()
	resetMessageCounts()
	return {
		getFetchSimulationStackText: () => fetchSimulationStackContainer.textContent,
		async openFetchSimulationStack() {
			await act(() => { render(<FetchSimulationStack />, fetchSimulationStackContainer) })
			await settleMessageFlow()
		},
		async cleanUp() {
			// FetchSimulationStack cannot remove its wrapped runtime listener, so detach the pages and let in-flight background work drain before the next test.
			routeBackgroundRequest = undefined
			pageListeners.length = 0
			resetMessageCounts()
			await settleMessageFlow()
			await act(() => {
				render(null, fetchSimulationStackContainer)
				render(null, consumerContainer)
			})
			dom.restore()
		},
	}
}

describe('FetchSimulationStack simulation refreshes', () => {
	test('opening next to a live simulation consumer simulates once and publishes once', async () => {
		const harness = await setUpSimulationModeWithOpenConsumer()
		try {
			await harness.openFetchSimulationStack()
			// One refresh for the complete visualisation and one simulation for the address references.
			assert.deepEqual(messageCounts, { simulationStatePublishes: 1, ethSimulateV1Requests: 2 })
			assert.equal(messagesInFlight, 0)
			assert.ok(harness.getFetchSimulationStackText().includes('would like to retrieve your Simulation Stack'))
			assert.equal(await getLatestUnexpectedError(), undefined)
		} finally {
			await harness.cleanUp()
		}
	})

	test('a new block simulates once and its publish does not start another refresh', async () => {
		const harness = await setUpSimulationModeWithOpenConsumer()
		try {
			await harness.openFetchSimulationStack()
			resetMessageCounts()
			// Mirrors the simulation-mode new-block handler in background-startup.ts.
			await act(async () => { await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService) })
			await settleMessageFlow()
			assert.deepEqual(messageCounts, { simulationStatePublishes: 1, ethSimulateV1Requests: 1 })
			assert.equal(messagesInFlight, 0)
			assert.equal(await getLatestUnexpectedError(), undefined)
		} finally {
			await harness.cleanUp()
		}
	})

	test('an explicit refresh simulates once and its invalidation and result publishes do not start another refresh', async () => {
		const harness = await setUpSimulationModeWithOpenConsumer()
		try {
			await harness.openFetchSimulationStack()
			resetMessageCounts()
			await act(async () => { await browser.runtime.sendMessage({ method: 'popup_refreshSimulation' }) })
			await settleMessageFlow()
			assert.deepEqual(messageCounts, { simulationStatePublishes: 2, ethSimulateV1Requests: 1 })
			assert.equal(messagesInFlight, 0)
			assert.equal(await getLatestUnexpectedError(), undefined)
		} finally {
			await harness.cleanUp()
		}
	})
})

const signerAddress = 0x1111111111111111111111111111111111111111n
const contractAddress = 0x2222222222222222222222222222222222222222n
const signerEntry: AddressBookEntry = { type: 'contact', name: 'Stack Signer', address: signerAddress, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: true, chainId: rpcNetwork.chainId }
const created = new Date('2024-01-01T00:00:00.000Z')
const blockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const

function createContractEntry(name: string): AddressBookEntry {
	return { type: 'contract', name, address: contractAddress, entrySource: 'User', chainId: rpcNetwork.chainId }
}

// A finished visualisation of one transaction from the signer to the named contract.
function createVisualizedTransactionStack(contractName: string, simulationId: number, blockNumber: bigint): CompleteVisualizedSimulation {
	const contractEntry = createContractEntry(contractName)
	const originalRequestParameters = { method: 'eth_sendTransaction' as const, params: [{ from: signerAddress, to: contractAddress, value: 0n, input: new Uint8Array() }] }
	const unsignedTransaction = { type: '1559' as const, from: signerAddress, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21_000n, to: contractAddress, value: 0n, input: new Uint8Array(), chainId: rpcNetwork.chainId, accessList: [] }
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' }
	const simulationStateInput = [{
		stateOverrides: {},
		transactions: [{ signedTransaction: mockSignTransaction(unsignedTransaction), website, created, originalRequestParameters, transactionIdentifier: 1n }],
		signedMessages: [],
		blockTimeManipulation,
		simulateWithZeroBaseFee: false,
	}]
	return {
		simulationUpdatingState: 'done',
		simulationResultState: 'done',
		simulationId,
		simulationState: {
			kind: 'simulated',
			value: { success: true, simulationStateInput, simulatedBlocks: [], blockNumber, blockTimestamp: created, baseFeePerGas: 1n, simulationConductedTimestamp: created, rpcNetwork },
		},
		addressBookEntries: [signerEntry, contractEntry, getNativeTokenErc20(rpcNetwork)],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		visualizedSimulationState: {
			success: true,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: [{
					website,
					created,
					parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
					transactionIdentifier: 1n,
					originalRequestParameters,
					tokenBalancesAfter: [],
					tokenPriceEstimates: [],
					tokenPriceQuoteToken: undefined,
					gasSpent: 21_000n,
					realizedGasPrice: 1n,
					quarantine: false,
					quarantineReasons: [],
					transactionStatus: 'Transaction Succeeded',
					transaction: { from: signerEntry, to: contractEntry, rpcNetwork, type: '1559', nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21_000n, value: 0n, input: new Uint8Array(), hash: 1n },
					events: [],
				}],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation,
			}],
		},
		numberOfAddressesMadeRich: 0,
	}
}

// Answers FetchSimulationStack's requests like a background whose stored visualisation predates the stack, as when no live simulation consumer was open.
function createBackgroundWithOutdatedStoredVisualisation(currentStackAddressBookEntries: readonly AddressBookEntry[]) {
	const simulationRequests: string[] = []
	const outdatedStoredVisualisation = createPassthroughCompleteVisualizedSimulation(1)
	return {
		simulationRequests,
		outdatedStoredVisualisation,
		async handle(message: unknown) {
			const method = getMessageMethod(message)
			switch (method) {
				case 'popup_requestCompleteVisualizedSimulation': {
					simulationRequests.push(method)
					return PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.serialize({ method, visualizedSimulatorState: outdatedStoredVisualisation })
				}
				case 'popup_requestSimulationMetadata': {
					simulationRequests.push(method)
					return PopupRequestsReplies.popup_requestSimulationMetadata.serialize({ method, metadata: { namedTokenIds: [], addressBookEntries: currentStackAddressBookEntries, ens: { ensNameHashes: [], ensLabelHashes: [] } } })
				}
				default: return undefined
			}
		},
	}
}

function createHeldReply<Reply>() {
	let release: (reply: Reply) => void = () => undefined
	const reply = new Promise<Reply>((resolve) => { release = resolve })
	return {
		release,
		async waitForRelease() {
			heldRequests += 1
			try {
				return await reply
			} finally {
				heldRequests -= 1
			}
		},
	}
}

// Holds FetchSimulationStack's opening replies until the test releases them, so publications can arrive first.
function createBackgroundWithHeldOpeningReplies() {
	const visualisation = createHeldReply<CompleteVisualizedSimulation>()
	const addressBookEntries = createHeldReply<readonly AddressBookEntry[]>()
	return {
		releaseVisualisation: visualisation.release,
		releaseAddressBookEntries: addressBookEntries.release,
		async handle(message: unknown) {
			const method = getMessageMethod(message)
			switch (method) {
				case 'popup_requestCompleteVisualizedSimulation': return PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.serialize({ method, visualizedSimulatorState: await visualisation.waitForRelease() })
				case 'popup_requestSimulationMetadata': return PopupRequestsReplies.popup_requestSimulationMetadata.serialize({ method, metadata: { namedTokenIds: [], addressBookEntries: await addressBookEntries.waitForRelease(), ens: { ensNameHashes: [], ensLabelHashes: [] } } })
				default: return undefined
			}
		},
	}
}

async function publishSimulationState(visualizedSimulatorState: CompleteVisualizedSimulation) {
	await act(async () => { await browser.runtime.sendMessage(serialize(MessageToPopup, { role: 'all', method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })) })
	await settleMessageFlow()
}

async function openFetchSimulationStackPage(background: { readonly handle: (message: unknown) => Promise<unknown> }) {
	pageListeners.length = 0
	installBrowserMock()
	routeBackgroundRequest = background.handle
	resetMessageCounts()
	const dom = installDomMock()
	await act(() => { render(<FetchSimulationStack />, dom.document.body) })
	await act(async () => { await browser.runtime.sendMessage(serialize(MessageToPopup, { role: 'all', method: 'popup_fetchSimulationStackRequest', data: pendingFetchSimulationStackRequest })) })
	await settleMessageFlow()
	return {
		getText: () => dom.document.body.textContent.replace(/\s+/g, ' '),
		async close() {
			routeBackgroundRequest = undefined
			pageListeners.length = 0
			await act(() => { render(null, dom.document.body) })
			dom.restore()
		},
	}
}

describe('FetchSimulationStack published simulation states', () => {
	test('first open requests the stack once and shows the address references of the current stack', async () => {
		const currentStack = createVisualizedTransactionStack('Current Contract', 2, 100n)
		const background = createBackgroundWithOutdatedStoredVisualisation(currentStack.addressBookEntries)
		const page = await openFetchSimulationStackPage(background)
		try {
			assert.deepEqual(background.simulationRequests.toSorted(), ['popup_requestCompleteVisualizedSimulation', 'popup_requestSimulationMetadata'])
			assert.ok(page.getText().includes('https://requester.example'))
			assert.ok(page.getText().includes('Current Contract'))
		} finally {
			await page.close()
		}
	})

	test('a new-block refresh keeps the address references while updating and then shows the refreshed stack without requesting again', async () => {
		const refreshedStack = createVisualizedTransactionStack('Current Contract', 3, 101n)
		const background = createBackgroundWithOutdatedStoredVisualisation(refreshedStack.addressBookEntries)
		const page = await openFetchSimulationStackPage(background)
		try {
			// A refresh first publishes the stored state as updating and then the finished result.
			await publishSimulationState({ ...background.outdatedStoredVisualisation, simulationId: 2, simulationUpdatingState: 'updating' })
			assert.ok(page.getText().includes('Current Contract'))
			assert.ok(page.getText().includes('No simulation stack'))
			await publishSimulationState(refreshedStack)
			assert.ok(page.getText().includes('Current Contract'))
			assert.ok(!page.getText().includes('No simulation stack'))
			assert.equal(background.simulationRequests.length, 2)
		} finally {
			await page.close()
		}
	})

	test('opening replies that arrive after a finished publication do not replace its stack or address references', async () => {
		const openingStack = createVisualizedTransactionStack('Opening Contract', 2, 100n)
		const background = createBackgroundWithHeldOpeningReplies()
		const page = await openFetchSimulationStackPage(background)
		try {
			await publishSimulationState(createVisualizedTransactionStack('Published Contract', 3, 101n))
			assert.ok(page.getText().includes('Published Contract'))
			background.releaseVisualisation(openingStack)
			background.releaseAddressBookEntries(openingStack.addressBookEntries)
			await settleMessageFlow()
			assert.ok(page.getText().includes('Published Contract'))
			assert.ok(!page.getText().includes('Opening Contract'))
		} finally {
			await page.close()
		}
	})

	test('an opening reply with the updating state of a refresh does not replace the published result of that refresh', async () => {
		const finishedStack = createVisualizedTransactionStack('Finished Contract', 3, 101n)
		const background = createBackgroundWithHeldOpeningReplies()
		const page = await openFetchSimulationStackPage(background)
		try {
			await publishSimulationState(finishedStack)
			// The reply captured the refresh while it was running: the previous rows under the same simulation id.
			background.releaseVisualisation(retainPreviousVisualisation(createVisualizedTransactionStack('Retained Contract', 2, 100n), { simulationId: 3, simulationUpdatingState: 'updating' }))
			background.releaseAddressBookEntries(finishedStack.addressBookEntries)
			await settleMessageFlow()
			assert.ok(page.getText().includes('Finished Contract'))
			assert.ok(!page.getText().includes('Retained Contract'))
		} finally {
			await page.close()
		}
	})

	test('an opening reply with the result of a refresh replaces the published updating state of that refresh', async () => {
		const finishedStack = createVisualizedTransactionStack('Finished Contract', 3, 101n)
		const background = createBackgroundWithHeldOpeningReplies()
		const page = await openFetchSimulationStackPage(background)
		try {
			await publishSimulationState(retainPreviousVisualisation(createVisualizedTransactionStack('Retained Contract', 2, 100n), { simulationId: 3, simulationUpdatingState: 'updating' }))
			background.releaseVisualisation(finishedStack)
			background.releaseAddressBookEntries(finishedStack.addressBookEntries)
			await settleMessageFlow()
			assert.ok(page.getText().includes('Finished Contract'))
			assert.ok(!page.getText().includes('Retained Contract'))
		} finally {
			await page.close()
		}
	})

	test('the opening address references still fill in when only an updating publication arrived first', async () => {
		const openingStack = createVisualizedTransactionStack('Opening Contract', 2, 100n)
		const background = createBackgroundWithHeldOpeningReplies()
		const page = await openFetchSimulationStackPage(background)
		try {
			await publishSimulationState(retainPreviousVisualisation(createPassthroughCompleteVisualizedSimulation(1), { simulationId: 2, simulationUpdatingState: 'updating' }))
			assert.ok(page.getText().includes('Getting simulation stack...'))
			background.releaseVisualisation(openingStack)
			background.releaseAddressBookEntries(openingStack.addressBookEntries)
			await settleMessageFlow()
			assert.ok(page.getText().includes('Opening Contract'))
		} finally {
			await page.close()
		}
	})

	test('a stack change shows the published stack and its address references without requesting again', async () => {
		const originalStack = createVisualizedTransactionStack('Original Contract', 2, 100n)
		const background = createBackgroundWithOutdatedStoredVisualisation(originalStack.addressBookEntries)
		const page = await openFetchSimulationStackPage(background)
		try {
			await publishSimulationState(originalStack)
			assert.ok(page.getText().includes('Original Contract'))
			await publishSimulationState(createVisualizedTransactionStack('Changed Contract', 3, 100n))
			assert.ok(page.getText().includes('Changed Contract'))
			assert.ok(!page.getText().includes('Original Contract'))
			assert.equal(background.simulationRequests.length, 2)
		} finally {
			await page.close()
		}
	})
})

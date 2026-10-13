// Shared setup for the stack visualizer (SimulationStackPage) and popup simulation-data hook tests: hook probes, DOM queries, message delivery and UpdateHomePage fixtures.
//
// Usage (at the top level of a test file):
//   const installRuntimeMessaging = createRuntimeMessagingInstaller()   // from test/tests/runtimeMessagingTestHarness.ts
//   const messaging = installRuntimeMessaging({ handlers: { runtimeMessage: replyToPopupRequests } })
//   await act(() => { render(h(SimulationStackPage, {}), dom.document.body) })
//   await act(() => { deliverHomePageUpdate(messaging, createStackHomePageUpdate(13, 1, 'Stack tab')) })
import { h } from 'preact'
import { useLiveSimulationHomeData } from '../../app/ts/components/hooks/useLiveSimulationHomeData.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import type { JsonRpcErrorResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { MessageToPopup, UpdateHomePage, type Settings } from '../../app/ts/types/interceptor-messages.js'
import { createPassthroughCompleteVisualizedSimulation, type BlockTimeManipulation, type CompleteVisualizedSimulation, type PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { serialize, type EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { replaceGlobal } from '../harness/globals.js'
import type { MockElement } from './domMock.js'
import { collectElements, getElementChildren, getNormalizedText, hasClass } from './domQueries.js'
import type { RuntimeMessaging } from './runtimeMessagingTestHarness.js'

// Hook probes

export function StackVisualizerHookProbe() {
	useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return h('div', {}, 'ready')
}

export function MainPopupSimulationStateProbe() {
	const { simVisResults } = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return h('div', {}, simVisResults.value.kind)
}

export function AddressSelectionProbe() {
	const { activeSimulationAddress, simVisResults, simulationUpdatingState } = useLiveSimulationHomeData({
		answerMainPopupOpen: true,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
	})
	return h('div', {}, `${ activeSimulationAddress.value?.toString() }/${ simVisResults.value.kind }/${ simulationUpdatingState.value ?? 'loading' }`)
}

export function CrossTabStackVisualizerHookProbe() {
	const { tabState } = useLiveSimulationHomeData({
		answerMainPopupOpen: false,
		answerSimulationDataConsumerOpen: true,
		requestFreshHomeDataOnMount: false,
		filterByTabId: false,
	})
	return h('div', {}, tabState.value?.tabIconDetails.iconReason ?? 'empty')
}

// Message delivery

// Delivers a home page update the way the background broadcasts it to every popup.
export function deliverHomePageUpdate(messaging: RuntimeMessaging, update: UpdateHomePage) {
	messaging.dispatch({ role: 'all', ...serialize(UpdateHomePage, update) })
}

export function deliverPopupMessage(messaging: RuntimeMessaging, message: MessageToPopup) {
	messaging.dispatch(serialize(MessageToPopup, message))
}

export function createSimulationStateChangedMessage(visualizedSimulatorState: CompleteVisualizedSimulation): MessageToPopup {
	return {
		role: 'all',
		method: 'popup_simulation_state_changed',
		data: { visualizedSimulatorState },
	}
}

// Other globals

// Queues requestAnimationFrame callbacks until flushAnimationFrames runs them; restore puts the DOM mock's immediate requestAnimationFrame back.
export function installQueuedAnimationFrames() {
	const animationFrames: FrameRequestCallback[] = []
	const restore = replaceGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		animationFrames.push(callback)
		return animationFrames.length
	})
	return {
		flushAnimationFrames: () => {
			for (const callback of animationFrames.splice(0)) callback(0)
		},
		restore,
	}
}

// DOM queries

export const getHeadersContainingText = (root: MockElement, text: string) => collectElements(root, 'header').filter((header) => header.textContent.includes(text))

export const countTextOccurrences = (input: string, text: string) => input.split(text).length - 1

export const findElementById = (root: MockElement, id: string) => [...collectElements(root, 'li'), ...collectElements(root, 'div')].find((element) => element.getAttribute('id') === id)

export const hasCompactStackCard = (root: MockElement) => collectElements(root, 'header').some((header) => getNormalizedText(header) === 'Stack')

export const getFirstElementChild = (element: MockElement) => getElementChildren(element)[0]

export const hasButtonWithText = (root: MockElement, text: string) => collectElements(root, 'button').some((button) => getNormalizedText(button) === text)

export const hasButtonWithAriaLabel = (root: MockElement, ariaLabel: string) => collectElements(root, 'button').some((button) => button.getAttribute('aria-label') === ariaLabel)

export function getParagraphByAriaLabel(root: MockElement, ariaLabel: string) {
	const paragraph = collectElements(root, 'p').find((element) => element.getAttribute('aria-label') === ariaLabel)
	if (paragraph === undefined) throw new Error(`Expected paragraph with aria-label "${ ariaLabel }"`)
	return paragraph
}

export const getRichAddressGroups = (paragraph: MockElement) => getElementChildren(paragraph).filter((child) => child.tagName === 'SPAN' && hasClass(child, 'rich-address-sentence-group'))

// Fixtures

const noBlockTimeChange: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }

const testRpcEntry: RpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const settings: Settings = {
	activeSimulationAddress: undefined,
	activeSigningSafeAddress: undefined,
	activeRpcNetwork: testRpcEntry,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: false,
}

export function createRichAddressEntry(address: bigint, name: string): AddressBookEntry {
	return {
		type: 'contact',
		name,
		address,
		entrySource: 'User',
		askForAddressAccess: true,
		useAsActiveAddress: true,
	}
}

export function createRichListElement(address: bigint, name: string): EnrichedRichListElement {
	return {
		addressBookEntry: createRichAddressEntry(address, name),
		makingRich: true,
		type: 'UserAdded',
	}
}

export function createHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich = 0, richList: readonly EnrichedRichListElement[] = []): UpdateHomePage {
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
			rpcEntries: [testRpcEntry],
			interceptorDisabled: false,
			preSimulationBlockTimeManipulation: noBlockTimeChange,
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
	return {
		signedTransaction: mockSignTransaction(transaction),
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [sendTransactionParams],
		},
		transactionIdentifier,
	}
}

export function createSerializableSettings(): Settings {
	return {
		...settings,
		simulationMode: true,
		activeSimulationAddress: undefined,
		activeRpcNetwork: testRpcEntry,
	}
}

export function createSimulatedCompleteVisualizedSimulation(serializableSettings: Settings, transactionIdentifiers: readonly bigint[] = [1n], numberOfAddressesMadeRich = 0): CompleteVisualizedSimulation {
	const simulationStateInput = [{
		stateOverrides: {},
		transactions: transactionIdentifiers.map(createPreSimulationTransaction),
		signedMessages: [],
		blockTimeManipulation: noBlockTimeChange,
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
				blockTimeManipulation: noBlockTimeChange,
			}],
		},
		numberOfAddressesMadeRich,
	}
}

// A signing-mode update whose active address is a Gnosis Safe with a stacked transaction.
export function createStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, transactionIdentifiers: readonly bigint[] = [1n], numberOfAddressesMadeRich = 0, richList: readonly EnrichedRichListElement[] = []): UpdateHomePage {
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
			rpcEntries: [testRpcEntry],
			preSimulationBlockTimeManipulation: noBlockTimeChange,
		},
	}
}

export function createNonSafeStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
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

// A simulation-mode update with one stacked transaction.
export function createSimulationStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
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

export function createSerializableRichHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string, numberOfAddressesMadeRich: number, richList: readonly EnrichedRichListElement[]): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason, numberOfAddressesMadeRich, richList)
	const serializableSettings = createSerializableSettings()
	return {
		...update,
		data: {
			...update.data,
			settings: serializableSettings,
			rpcEntries: [testRpcEntry],
			preSimulationBlockTimeManipulation: noBlockTimeChange,
		},
	}
}

export function createFailedStackHomePageUpdate(tabId: number, popupRefreshGeneration: number, iconReason: string): UpdateHomePage {
	const update = createHomePageUpdate(tabId, popupRefreshGeneration, iconReason)
	const serializableSettings = createSerializableSettings()
	const jsonRpcError: JsonRpcErrorResponse = { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }
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
							blockTimeManipulation: noBlockTimeChange,
							simulateWithZeroBaseFee: false,
						}],
						jsonRpcError,
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
					jsonRpcError,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: noBlockTimeChange,
					}],
				},
				numberOfAddressesMadeRich: 0,
			},
			settings: serializableSettings,
			rpcEntries: [testRpcEntry],
			preSimulationBlockTimeManipulation: noBlockTimeChange,
		},
	}
}

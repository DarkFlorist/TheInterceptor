// Shared fixtures and helpers for the Home popup page tests (homeSettingsChangeProgress, homeSimulationResultsAndStackActions, homeActiveAddressSelector and homeSafeSimulationSigner).
import { Signal } from '@preact/signals'
import { ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import type { ContactEntry, SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { HomeParams, RpcConnectionStatus, TabState } from '../../app/ts/types/user-interface-types.js'
import { toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, PreSimulationTransaction, ResolvedSimulationResults, SignedMessageTransaction, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { replaceGlobal } from '../harness/globals.js'
import type { MockElement } from './domMock.js'
import { getMessageWithMethod } from './runtimeMessageMatchers.js'
import { collectElements, findAncestor, getButtonByText, getElement, getNormalizedText, hasClass } from './domQueries.js'

export const readHomeSource = async () => await Bun.file(new URL('../../app/ts/components/pages/Home.tsx', import.meta.url)).text()

export const ACTIVE_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n
export const SAFE_ADDRESS = 0x3000000000000000000000000000000000000003n
export const SAFE_SIGNER_ADDRESS = 0x4000000000000000000000000000000000000004n
export const OTHER_SIGNER_ADDRESS = 0x5000000000000000000000000000000000000005n

export const activeAddressEntry: ContactEntry = {
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

export const safeEntry: SafeEntry = {
	type: 'safe',
	name: 'Treasury Safe',
	address: SAFE_ADDRESS,
	safeSimulationSignerAddress: SAFE_SIGNER_ADDRESS,
	safeSignerAddresses: [SAFE_SIGNER_ADDRESS, OTHER_SIGNER_ADDRESS],
	chainId: 1n,
	entrySource: 'User',
	useAsActiveAddress: true,
}

export const safeSignerEntry: ContactEntry = {
	type: 'contact',
	name: 'Safe owner account',
	address: SAFE_SIGNER_ADDRESS,
	entrySource: 'User',
}

export const rpcNetwork: RpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const ZERO_BLOCK_TIME_MANIPULATION: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }

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

const makeSafePreSimulationTransaction = (): PreSimulationTransaction => {
	const safeTx: SafeTx = {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: { chainId: 1n, verifyingContract: SAFE_ADDRESS },
		message: {
			to: RECIPIENT_ADDRESS,
			value: 0n,
			data: new Uint8Array(),
			operation: 0n,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: 0n,
			refundReceiver: 0n,
			nonce: 0n,
		},
	}
	return {
		...makePreSimulationTransaction(),
		safeTransaction: {
			safeTx,
			safeTxHash: 1n,
			created: new Date('2024-01-01T00:00:00.000Z'),
			websiteOrigin: 'https://example.com',
			transactionIdentifier: 1n,
			signatures: [],
		},
	}
}

const makeSignedMessageTransaction = (): SignedMessageTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	activeAddress: ACTIVE_ADDRESS,
	fakeSignedFor: ACTIVE_ADDRESS,
	originalRequestParameters: { method: 'personal_sign', params: ['0x68656c6c6f', ACTIVE_ADDRESS] },
	request: {
		method: 'personal_sign',
		params: ['0x68656c6c6f', ACTIVE_ADDRESS],
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
	},
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

export const createSimulationResults = (): SimulationAndVisualisationResults => ({
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

export const createEmptySimulationResults = (): SimulationAndVisualisationResults => ({
	...createSimulationResults(),
	simulationStateInput: [],
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [],
	},
})

export const createSafeSimulationResults = (): SimulationAndVisualisationResults => ({
	...createSimulationResults(),
	simulationStateInput: [{
		stateOverrides: {},
		transactions: [makeSafePreSimulationTransaction()],
		signedMessages: [],
		blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		simulateWithZeroBaseFee: true,
	}],
})

export const createPendingSimulationResults = (): SimulationAndVisualisationResults => ({
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

export const createPendingSignedMessageSimulationResults = (): SimulationAndVisualisationResults => ({
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

export function createHomeParams(overrides: Partial<HomeParams> = {}): HomeParams {
	return {
		isActiveAddressChanging: new Signal(false),
		isActiveAddressChangePending: new Signal(false),
		isSettingsChangePending: new Signal(false),
		setSimulationMode: async () => undefined,
		setRichState: async () => undefined,
		changeActiveAddress: () => undefined,
		makeCurrentAddressRich: new Signal(false),
		activeAddresses: new Signal([activeAddressEntry]),
		walletSelectedAddressBookEntry: new Signal(undefined),
		tabState: new Signal<TabState | undefined>(undefined),
		activeSimulationAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
		activeSigningSafeAddress: new Signal<bigint | undefined>(undefined),
		displayedSigningAddress: new Signal<bigint | undefined>(undefined),
		useSignersAddressAsActiveAddress: new Signal(false),
		simVisResults: new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults())),
		rpcNetwork: new Signal(rpcNetwork),
		setActiveRpcAndInformAboutIt: async () => undefined,
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
		hasSafeTransactionsToExport: new Signal(false),
		isInitialHomeDataLoaded: new Signal(true),
		isFreshHomeDataLoaded: new Signal(true),
		...overrides,
	}
}


// DOM helpers specific to the Home page

export const getActiveAddressRow = (root: MockElement) => getElement(root, (element) => element.tagName === 'DIV' && hasClass(element, 'active-address-row'), 'the active address row')

export function getAncestor(element: MockElement, tagName: string) {
	const ancestor = findAncestor(element, (candidate) => candidate.tagName === tagName.toUpperCase())
	if (ancestor === undefined) throw new Error(`Expected ancestor ${ tagName }`)
	return ancestor
}

export function getButtonInTimePicker(root: MockElement, timePickerLabel: string, buttonText: string) {
	const timePickerLabelElement = collectElements(root, 'p').find((element) => getNormalizedText(element) === timePickerLabel)
	const timePicker = timePickerLabelElement?.parentNode
	if (timePicker === undefined || timePicker === null) throw new Error(`Expected time picker label "${ timePickerLabel }"`)
	return getButtonByText(timePicker, buttonText)
}

// The message as the background receives it: browser messaging delivers a structured clone, which turns the serialized null-prototype records into ordinary objects.
export function getDeliveredMessageWithMethod(messages: readonly unknown[], method: string) {
	return structuredClone(getMessageWithMethod(messages, method))
}

// Replaces window.close, which the popup calls after opening the simulation stack.
export function installCloseMock() {
	let closeCount = 0
	const restore = replaceGlobal('close', () => { closeCount += 1 })
	return {
		get closeCount() { return closeCount },
		restore,
	}
}

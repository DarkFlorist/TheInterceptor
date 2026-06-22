import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import { installDomMock } from './domMock.js'
import { ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { RpcConnectionStatus, TabState } from '../../app/ts/types/user-interface-types.js'
import { toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, PreSimulationTransaction, ResolvedSimulationResults, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'

const ACTIVE_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n

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

describe('Home popup clear empty state', () => {
	test('rerenders to the empty-state dino when simulation results are cleared', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createSimulationResults()))
		try {
			await act(() => {
				render(h(Home, {
					changeActiveAddress: () => undefined,
					makeCurrentAddressRich: new Signal(false),
					activeAddresses: new Signal([activeAddressEntry]),
					tabState: new Signal<TabState | undefined>(undefined),
					activeSimulationAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(undefined),
					useSignersAddressAsActiveAddress: new Signal(false),
					simVisResults,
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
					openImportSimulation: () => undefined,
				}), dom.document.body)
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
				render(h(Home, {
					changeActiveAddress: () => undefined,
					makeCurrentAddressRich: new Signal(false),
					activeAddresses: new Signal([activeAddressEntry]),
					tabState: new Signal<TabState | undefined>(undefined),
					activeSimulationAddress: new Signal<bigint | undefined>(ACTIVE_ADDRESS),
					activeSigningAddress: new Signal<bigint | undefined>(undefined),
					useSignersAddressAsActiveAddress: new Signal(false),
					simVisResults,
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
					numberOfAddressesMadeRich: new Signal(2),
					openImportSimulation: () => undefined,
				}), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('Simply making 2 addresses rich'), true)
			assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), false)
		} finally {
			dom.restore()
		}
	})

	test('treats a known signer account as connected even if the signerConnected flag is stale', async () => {
		const dom = installDomMock()
		const simVisResults = new Signal<ResolvedSimulationResults>(toResolvedSimulationResults(createEmptySimulationResults()))
		try {
			await act(() => {
				render(h(Home, {
					changeActiveAddress: () => undefined,
					makeCurrentAddressRich: new Signal(false),
					activeAddresses: new Signal([activeAddressEntry]),
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
					rpcNetwork: new Signal(rpcNetwork),
					setActiveRpcAndInformAboutIt: () => undefined,
					simulationMode: new Signal(false),
					tabIconDetails: new Signal({ icon: ICON_SIMULATING, iconReason: 'Connected through MetaMask.' }),
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
					openImportSimulation: () => undefined,
				}), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('CONNECTED'), true)
			assert.equal(dom.document.body.textContent?.includes('NOT CONNECTED'), false)
		} finally {
			dom.restore()
		}
	})
})

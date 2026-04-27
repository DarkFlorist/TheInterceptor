import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { Home } from '../../app/ts/components/pages/Home.js'
import { installDomMock } from './someTimeAgo.js'
import { ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { RpcConnectionStatus, TabState } from '../../app/ts/types/user-interface-types.js'
import type { BlockTimeManipulation, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'

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

const makeSimulatedTransaction = (): SimulatedAndVisualizedTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier: 1n,
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: ACTIVE_ADDRESS, to: RECIPIENT_ADDRESS, value: 0n, input: new Uint8Array() }] },
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 21_000n,
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

async function main() {
	describe('Home popup clear empty state', () => {
		should('rerenders to the empty-state dino when simulation results are cleared', async () => {
			const dom = installDomMock()
			const simVisResults = new Signal<SimulationAndVisualisationResults | undefined>(createSimulationResults())
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
						openImportSimulation: () => undefined,
					}), dom.document.body as unknown as Element)
				})

				await act(() => {
					simVisResults.value = undefined
				})

				assert.equal(dom.document.body.textContent?.includes('Give me some transactions to munch on!'), true)
			} finally {
				dom.restore()
			}
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)

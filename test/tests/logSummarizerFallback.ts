import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { LogSummarizer } from '../../app/ts/simulation/services/LogSummarizer.js'
import { SimulationSummary } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import { installDomMock } from './someTimeAgo.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import type { AddressBookEntry, ContactEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent, TokenVisualizerNFTAllApprovalEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { BlockTimeManipulation, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'

const TOKEN_ADDRESS = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n
const ERC721_TOKEN_ADDRESS = 0x3000000000000000000000000000000000000003n
const ERC1155_TOKEN_ADDRESS = 0x4000000000000000000000000000000000000004n
const SENDER_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n
const OPERATOR_ADDRESS = 0x5000000000000000000000000000000000000005n

const tokenEntry: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Wrapped Ether',
	symbol: 'WETH',
	decimals: 18n,
	address: TOKEN_ADDRESS,
	entrySource: 'DarkFloristMetadata',
}

const senderEntry: ContactEntry = {
	type: 'contact',
	name: 'Sender',
	address: SENDER_ADDRESS,
	entrySource: 'OnChain',
}

const recipientEntry: ContactEntry = {
	type: 'contact',
	name: 'Recipient Missing From External Map',
	address: RECIPIENT_ADDRESS,
	entrySource: 'OnChain',
}

const operatorEntry: ContactEntry = {
	type: 'contact',
	name: 'Operator Missing From External Map',
	address: OPERATOR_ADDRESS,
	entrySource: 'OnChain',
}

const erc721TokenEntry: Erc721Entry = {
	type: 'ERC721',
	name: 'NFT Collection',
	symbol: 'NFT',
	address: ERC721_TOKEN_ADDRESS,
	entrySource: 'DarkFloristMetadata',
}

const erc1155TokenEntry: Erc1155Entry = {
	type: 'ERC1155',
	name: 'Game Items',
	symbol: 'ITEM',
	decimals: undefined,
	address: ERC1155_TOKEN_ADDRESS,
	entrySource: 'DarkFloristMetadata',
}

const rpcNetwork: RpcNetwork = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const ZERO_BLOCK_TIME_MANIPULATION: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }

const makeTransferEvent = (): TokenEvent => ({
	type: 'TokenEvent',
	isParsed: 'Parsed',
	name: 'Transfer',
	signature: 'Transfer(address,address,uint256)',
	args: [],
	address: TOKEN_ADDRESS,
	loggersAddressBookEntry: tokenEntry,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		type: 'ERC20',
		logObject: undefined,
		from: senderEntry,
		to: recipientEntry,
		token: tokenEntry,
		amount: 5n,
		isApproval: false,
	},
})

const makeSimulatedTransaction = (): SimulatedAndVisualizedTransaction => ({
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier: 1n,
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: SENDER_ADDRESS, to: TOKEN_ADDRESS, value: 0n, input: new Uint8Array() }] },
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 0n,
	realizedGasPrice: 1n,
	quarantine: false,
	quarantineReasons: [],
	transactionStatus: 'Transaction Succeeded',
	transaction: {
		from: senderEntry,
		to: tokenEntry,
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
	events: [makeTransferEvent()],
})

const createTransactionWithEvent = (event: SimulatedAndVisualizedTransaction['events'][number], to: AddressBookEntry = tokenEntry): SimulatedAndVisualizedTransaction => ({
	...makeSimulatedTransaction(),
	transaction: {
		...makeSimulatedTransaction().transaction,
		to,
	},
	events: [event],
})

const getSummaryForTransaction = (simulatedTransaction: SimulatedAndVisualizedTransaction, externalEntries: readonly AddressBookEntry[]) => {
	const summarizer = new LogSummarizer([simulatedTransaction])
	const externalMetadata = new Map<string, AddressBookEntry>(externalEntries.map((entry) => [addressString(entry.address), entry]))
	return summarizer.getSummary(externalMetadata, [], [])
}

const renderSimulationSummary = (dom: ReturnType<typeof installDomMock>, simulationAndVisualisationResults: Signal<SimulationAndVisualisationResults>) => {
	render(h(SimulationSummary, {
		simulationAndVisualisationResults,
		currentBlockNumber: new Signal<bigint | undefined>(1n),
		activeAddress: new Signal<bigint | undefined>(RECIPIENT_ADDRESS),
		renameAddressCallBack: () => undefined,
		rpcConnectionStatus: new Signal(undefined),
	}),
	// @ts-expect-error test shim uses a lightweight container
	dom.document.body)
}

async function main() {
	describe('LogSummarizer fallback metadata', () => {
		should('uses enriched event metadata when the external map is incomplete', () => {
			const simulatedTransaction = makeSimulatedTransaction()
			const summarizer = new LogSummarizer([simulatedTransaction])
			const externalMetadata = new Map<string, AddressBookEntry>([
				[addressString(tokenEntry.address), tokenEntry],
				[addressString(senderEntry.address), senderEntry],
			])

			const summary = summarizer.getSummary(externalMetadata, [], [])
			const recipientSummary = summary.find((entry) => entry.summaryFor.address === RECIPIENT_ADDRESS)

			assert.notEqual(recipientSummary, undefined)
			assert.equal(recipientSummary?.summaryFor.name, recipientEntry.name)
		})

		should('uses enriched approval target metadata when ERC20 approval address is missing from the external map', () => {
			const simulatedTransaction = createTransactionWithEvent({
				type: 'TokenEvent',
				isParsed: 'Parsed',
				name: 'Approval',
				signature: 'Approval(address,address,uint256)',
				args: [],
				address: TOKEN_ADDRESS,
				loggersAddressBookEntry: tokenEntry,
				data: new Uint8Array(),
				topics: [],
				logInformation: {
					type: 'ERC20',
					logObject: undefined,
					from: senderEntry,
					to: operatorEntry,
					token: tokenEntry,
					amount: 10n,
					isApproval: true,
				},
			})

			const summary = getSummaryForTransaction(simulatedTransaction, [tokenEntry, senderEntry])
			assert.equal(summary[0]?.erc20TokenApprovalChanges[0]?.approvals[0]?.name, operatorEntry.name)
		})

		should('uses enriched approved address metadata when ERC721 approval address is missing from the external map', () => {
			const simulatedTransaction = createTransactionWithEvent({
				type: 'TokenEvent',
				isParsed: 'Parsed',
				name: 'Approval',
				signature: 'Approval(address,address,uint256)',
				args: [],
				address: ERC721_TOKEN_ADDRESS,
				loggersAddressBookEntry: erc721TokenEntry,
				data: new Uint8Array(),
				topics: [],
				logInformation: {
					type: 'ERC721',
					logObject: undefined,
					from: senderEntry,
					to: operatorEntry,
					token: erc721TokenEntry,
					tokenId: 1n,
					isApproval: true,
				},
			}, erc721TokenEntry)

			const summary = getSummaryForTransaction(simulatedTransaction, [erc721TokenEntry, senderEntry])
			assert.equal(summary[0]?.erc721TokenIdApprovalChanges[0]?.approvedEntry.name, operatorEntry.name)
		})

		should('uses enriched operator metadata when ApprovalForAll operator is missing from the external map', () => {
			const approvalForAllLogInformation: TokenVisualizerNFTAllApprovalEvent = {
				type: 'NFT All approval',
				logObject: undefined,
				from: senderEntry,
				to: operatorEntry,
				token: erc1155TokenEntry,
				allApprovalAdded: true,
				isApproval: true,
			}
			const simulatedTransaction = createTransactionWithEvent({
				type: 'TokenEvent',
				isParsed: 'Parsed',
				name: 'ApprovalForAll',
				signature: 'ApprovalForAll(address,address,bool)',
				args: [],
				address: ERC1155_TOKEN_ADDRESS,
				loggersAddressBookEntry: erc1155TokenEntry,
				data: new Uint8Array(),
				topics: [],
				logInformation: approvalForAllLogInformation,
			}, erc1155TokenEntry)

			const summary = getSummaryForTransaction(simulatedTransaction, [erc1155TokenEntry, senderEntry])
			assert.equal(summary[0]?.erc721and1155OperatorChanges[0]?.operator?.name, operatorEntry.name)
		})

		should('renders SimulationSummary with the fallback account name instead of crashing', async () => {
			const dom = installDomMock()
			const simulatedTransaction = makeSimulatedTransaction()
			const simulationAndVisualisationResultsData: SimulationAndVisualisationResults = {
				blockNumber: 1n,
				blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
				simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
				addressBookEntries: [tokenEntry, senderEntry],
				rpcNetwork,
				tokenPriceEstimates: [],
				visualizedSimulationState: {
					success: true,
					visualizedBlocks: [{
						simulatedAndVisualizedTransactions: [simulatedTransaction],
						visualizedPersonalSignRequests: [],
						blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
					}],
				},
				namedTokenIds: [],
			}
			const simulationAndVisualisationResults = new Signal(simulationAndVisualisationResultsData)

			await act(() => {
				renderSimulationSummary(dom, simulationAndVisualisationResults)
			})

			assert.equal(dom.document.body.textContent?.includes(recipientEntry.name), true)
			dom.restore()
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)

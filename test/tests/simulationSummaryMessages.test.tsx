import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { SimulationSummary } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import type { ContactEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import { installDomMock } from './domMock.js'

const SIGNER_ADDRESS = 0x1000000000000000000000000000000000000001n
const RECIPIENT_ADDRESS = 0x2000000000000000000000000000000000000002n
const TOKEN_ADDRESS = 0x3000000000000000000000000000000000000003n

const signerEntry: ContactEntry = {
	type: 'contact',
	name: 'Simulation signer',
	address: SIGNER_ADDRESS,
	entrySource: 'User',
	useAsActiveAddress: true,
	askForAddressAccess: true,
}

const recipientEntry: ContactEntry = {
	type: 'contact',
	name: 'Token recipient',
	address: RECIPIENT_ADDRESS,
	entrySource: 'OnChain',
}

const tokenEntry: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Summary Token',
	symbol: 'SUM',
	decimals: 18n,
	address: TOKEN_ADDRESS,
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

const blockTimeManipulation: BlockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' }

function makeSignature({
	messageIdentifier,
	websiteTitle,
	quarantineReasons = [],
	isValidMessage,
}: {
	messageIdentifier: bigint
	websiteTitle: string
	quarantineReasons?: readonly string[]
	isValidMessage?: boolean
}): VisualizedPersonalSignRequest {
	const message = `Message ${ messageIdentifier.toString() }`
	return {
		method: 'personal_sign',
		type: 'NotParsed',
		message,
		messageHash: `0x${ messageIdentifier.toString(16) }`,
		simulationMode: true,
		signerName: 'NoSigner',
		activeAddress: signerEntry,
		rpcNetwork,
		quarantineReasons,
		quarantine: quarantineReasons.length > 0,
		account: signerEntry,
		website: {
			websiteOrigin: `https://${ websiteTitle.toLowerCase().replaceAll(' ', '-') }.example`,
			title: websiteTitle,
			icon: undefined,
		},
		created: new Date('2024-01-01T00:00:00.000Z'),
		rawMessage: message,
		stringifiedMessage: message,
		messageIdentifier,
		isValidMessage,
	}
}

const transferEvent: TokenEvent = {
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
		from: signerEntry,
		to: recipientEntry,
		token: tokenEntry,
		amount: 5n,
		isApproval: false,
	},
}

const simulatedTransaction: SimulatedAndVisualizedTransaction = {
	website: { websiteOrigin: 'https://transaction.example', icon: undefined, title: 'Transaction Example' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier: 1n,
	originalRequestParameters: {
		method: 'eth_sendTransaction',
		params: [{ from: SIGNER_ADDRESS, to: TOKEN_ADDRESS, value: 0n, input: new Uint8Array() }],
	},
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 0n,
	realizedGasPrice: 1n,
	quarantine: false,
	quarantineReasons: [],
	transactionStatus: 'Transaction Succeeded',
	transaction: {
		from: signerEntry,
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
	events: [transferEvent],
}

function makeResults(blocks: SimulationAndVisualisationResults['visualizedSimulationState']['visualizedBlocks']): SimulationAndVisualisationResults {
	return {
		blockNumber: 100n,
		blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
		simulationConductedTimestamp: new Date('2024-01-01T00:00:05.000Z'),
		simulationStateInput: [],
		addressBookEntries: [signerEntry, recipientEntry, tokenEntry],
		visualizedSimulationState: { success: true, visualizedBlocks: blocks },
		rpcNetwork,
		tokenPriceEstimates: [],
		namedTokenIds: [],
	}
}

function renderSummary(simulationAndVisualisationResults: SimulationAndVisualisationResults) {
	const dom = installDomMock()
	render(h(SimulationSummary, {
		simulationAndVisualisationResults: new Signal(toResolvedSimulationResults(simulationAndVisualisationResults)),
		currentBlockNumber: new Signal<bigint | undefined>(100n),
		activeAddress: new Signal<bigint | undefined>(SIGNER_ADDRESS),
		renameAddressCallBack: () => undefined,
		rpcConnectionStatus: new Signal(undefined),
	}), dom.document.body)
	return dom
}

type TestNode = {
	childNodes?: readonly TestNode[]
	getAttribute?: (name: string) => string | null
}

function collectAttributeValues(node: TestNode, attributeName: string): string[] {
	const currentValue = node.getAttribute?.(attributeName)
	const descendantValues = (node.childNodes ?? []).flatMap((child) => collectAttributeValues(child, attributeName))
	return currentValue === undefined || currentValue === null ? descendantValues : [currentValue, ...descendantValues]
}

describe('SimulationSummary simulated signatures', () => {
	test('renders message-only summaries in block order and surfaces quarantined messages', async () => {
		const firstSignature = makeSignature({ messageIdentifier: 1n, websiteTitle: 'First App' })
		const secondSignature = makeSignature({
			messageIdentifier: 2n,
			websiteTitle: 'Second App',
			quarantineReasons: ['Untrusted signing domain'],
		})
		const dom = renderSummary(makeResults([
			{
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [firstSignature],
				blockTimeManipulation,
			},
			{
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [secondSignature],
				blockTimeManipulation,
			},
		]))

		try {
			await act(() => undefined)
			const summaryText = dom.document.body.textContent
			assert.equal(summaryText.includes('Simulated signatures (2)'), true)
			assert.equal(summaryText.includes('Simulation signer'), true)
			assert.equal(summaryText.includes('Flagged: Untrusted signing domain'), true)
			assert.equal(summaryText.indexOf('First App') < summaryText.indexOf('Second App'), true)
			assert.equal(summaryText.includes('No changes to your accounts'), true)
			assert.equal(collectAttributeValues(dom.document.body, 'src').filter((src) => src === '../img/warning-sign.svg').length, 2)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('uses invalid signature state for the aggregate outcome', async () => {
		const invalidSignature = makeSignature({
			messageIdentifier: 3n,
			websiteTitle: 'Invalid Message App',
			isValidMessage: false,
		})
		const dom = renderSummary(makeResults([{
			simulatedAndVisualizedTransactions: [],
			visualizedPersonalSignRequests: [invalidSignature],
			blockTimeManipulation,
		}]))

		try {
			await act(() => undefined)
			assert.equal(dom.document.body.textContent.includes('Invalid message format'), true)
			assert.equal(collectAttributeValues(dom.document.body, 'src').filter((src) => src === '../img/error-icon.svg').length, 2)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('shows signatures alongside transaction account outcomes', async () => {
		const signature = makeSignature({ messageIdentifier: 4n, websiteTitle: 'Mixed Stack App' })
		const dom = renderSummary(makeResults([{
			simulatedAndVisualizedTransactions: [simulatedTransaction],
			visualizedPersonalSignRequests: [signature],
			blockTimeManipulation,
		}]))

		try {
			await act(() => undefined)
			const summaryText = dom.document.body.textContent
			assert.equal(summaryText.includes('Simulated signatures (1)'), true)
			assert.equal(summaryText.includes('Mixed Stack App'), true)
			assert.equal(summaryText.includes('Summary Token'), true)
			assert.equal(summaryText.includes('Included in this simulation'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('does not add an empty signatures section to transaction-only summaries', async () => {
		const dom = renderSummary(makeResults([{
			simulatedAndVisualizedTransactions: [simulatedTransaction],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation,
		}]))

		try {
			await act(() => undefined)
			assert.equal(dom.document.body.textContent.includes('Simulated signatures'), false)
			assert.equal(dom.document.body.textContent.includes('Summary Token'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})

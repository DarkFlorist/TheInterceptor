import * as assert from 'node:assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { GasLimitEditor, getGasUsageText, SimulationSummary, TransactionHeader } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import type { ContactEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnsEvent, TokenEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { toResolvedSimulationResults } from '../../app/ts/types/visualizer-types.js'
import type { BlockTimeManipulation, SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction, VisualizedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { installDomMock, type MockElement } from './domMock.js'
import { collectElements, findAllElements, findElement, getElementByClass, isDisabled } from './domQueries.js'

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

const ensTextChangeEvent: EnsEvent = {
	type: 'ENS',
	subType: 'ENSTextChangedKeyValue',
	isParsed: 'Parsed',
	name: 'TextChanged',
	signature: 'TextChanged(bytes32,string,string)',
	args: [],
	address: TOKEN_ADDRESS,
	loggersAddressBookEntry: tokenEntry,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		node: {
			nameHash: 0n,
			name: 'vitalik.eth',
		},
		indexedKey: new Uint8Array([1, 2, 3]),
		key: 'avatar',
		value: 'ipfs://updated-avatar',
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

type SuccessfulVisualizedBlocks = Extract<VisualizedSimulationState, { success: true }>['visualizedBlocks']

function makeResults(blocks: SuccessfulVisualizedBlocks): SimulationAndVisualisationResults {
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
		editEnsNamedHashCallBack: () => undefined,
		rpcConnectionStatus: new Signal(undefined),
	}), dom.document.body)
	return dom
}

const collectAttributeValues = (root: MockElement, attributeName: string) => findAllElements(root, (element) => element.hasAttribute(attributeName)).map((element) => element.getAttribute(attributeName))

describe('SimulationSummary aggregate changes', () => {
	test('renders zero gas limits without dividing by zero', () => {
		assert.equal(getGasUsageText(0n, 0n), '0 / 0 gas (percentage unavailable)')
	})
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
			assert.notEqual(collectElements(dom.document.body, 'details')[0]?.getAttribute('open'), null)
		} finally {
			render(undefined, dom.document.body)
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
			render(undefined, dom.document.body)
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
			render(undefined, dom.document.body)
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
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows ENS changes from simulated transactions in their own collapsible section', async () => {
		const transactionWithEnsChange: SimulatedAndVisualizedTransaction = {
			...simulatedTransaction,
			events: [ensTextChangeEvent],
		}
		const dom = renderSummary(makeResults([{
			simulatedAndVisualizedTransactions: [transactionWithEnsChange],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation,
		}]))

		try {
			await act(() => undefined)
			const summaryText = dom.document.body.textContent
			assert.equal(summaryText.includes('ENS changes (1)'), true)
			assert.equal(summaryText.includes('Change ENS text value of'), true)
			assert.equal(summaryText.includes('vitalik.eth'), true)
			assert.equal(summaryText.includes('avatar'), true)
			assert.equal(summaryText.includes('ipfs://updated-avatar'), true)
			assert.equal(summaryText.includes('Simulated signatures'), false)
			assert.notEqual(collectElements(dom.document.body, 'details')[0]?.getAttribute('open'), null)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})

describe('SummarizeAddress', () => {
	// The own-account row is keyed by address, so the same SummarizeAddress instance receives the new balance summary.
	test('follows the balance summary of a kept account row when the simulation results change', async () => {
		const dom = installDomMock()
		const renamedSigner: ContactEntry = { ...signerEntry, name: 'Renamed signer' }
		const renderResults = async (signer: ContactEntry, amount: bigint) => {
			const transferFromSigner: TokenEvent = { ...transferEvent, logInformation: { type: 'ERC20', logObject: undefined, from: signer, to: recipientEntry, token: tokenEntry, amount, isApproval: false } }
			const transaction: SimulatedAndVisualizedTransaction = { ...simulatedTransaction, transaction: { ...simulatedTransaction.transaction, from: signer }, events: [transferFromSigner] }
			const results = { ...makeResults([{ simulatedAndVisualizedTransactions: [transaction], visualizedPersonalSignRequests: [], blockTimeManipulation }]), addressBookEntries: [signer, recipientEntry, tokenEntry] }
			await act(() => {
				render(h(SimulationSummary, {
					simulationAndVisualisationResults: new Signal(toResolvedSimulationResults(results)),
					currentBlockNumber: new Signal<bigint | undefined>(100n),
					activeAddress: new Signal<bigint | undefined>(SIGNER_ADDRESS),
					renameAddressCallBack: () => undefined,
					editEnsNamedHashCallBack: () => undefined,
					rpcConnectionStatus: new Signal(undefined),
				}), dom.document.body)
			})
		}
		const ownAccountChangesText = () => getElementByClass(dom.document.body, 'transaction-importance-box').textContent
		try {
			await renderResults(signerEntry, 5n * 10n ** 18n)
			assert.equal(ownAccountChangesText().includes('Simulation signer'), true)
			assert.equal(ownAccountChangesText().includes('- 5Summary Token'), true)

			await renderResults(renamedSigner, 7n * 10n ** 18n)
			assert.equal(ownAccountChangesText().includes('Renamed signer'), true)
			assert.equal(ownAccountChangesText().includes('Simulation signer'), false)
			assert.equal(ownAccountChangesText().includes('- 7Summary Token'), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})

describe('TransactionHeader', () => {
	test('updates the status icon when a kept row is re-rendered with a re-simulated transaction', async () => {
		const dom = installDomMock()
		const failedTransaction: SimulatedAndVisualizedTransaction = {
			...simulatedTransaction,
			transactionStatus: 'Transaction Failed',
			error: { code: 3, message: 'execution reverted', decodedErrorMessage: 'execution reverted' },
		}
		try {
			await act(() => {
				render(h(TransactionHeader, { simTx: simulatedTransaction }), dom.document.body)
			})
			assert.deepEqual(collectAttributeValues(dom.document.body, 'src'), ['../img/success-icon.svg'])

			await act(() => {
				render(h(TransactionHeader, { simTx: failedTransaction }), dom.document.body)
			})
			assert.deepEqual(collectAttributeValues(dom.document.body, 'src'), ['../img/error-icon.svg'])

			await act(() => {
				render(h(TransactionHeader, { simTx: { ...simulatedTransaction, quarantine: true, quarantineReasons: ['Suspicious recipient'] } }), dom.document.body)
			})
			assert.deepEqual(collectAttributeValues(dom.document.body, 'src'), ['../img/warning-sign.svg'])
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})

describe('GasLimitEditor', () => {
	test('follows a changed transaction gas limit so the Change button stays disabled for an untouched draft', async () => {
		const dom = installDomMock()
		const isChangeButtonDisabled = () => {
			const changeButton = findElement(dom.document.body, (element) => element.tagName === 'BUTTON' && element.textContent.includes('Change'))
			if (changeButton === undefined) throw new Error('Expected the Change button')
			return isDisabled(changeButton)
		}
		try {
			await act(() => {
				render(h(GasLimitEditor, { transactionIdentifier: 1n, initialGasLimit: 21_000n, isRawTransaction: false }), dom.document.body)
			})
			assert.equal(isChangeButtonDisabled(), true)

			await act(() => {
				render(h(GasLimitEditor, { transactionIdentifier: 1n, initialGasLimit: 50_000n, isRawTransaction: false }), dom.document.body)
			})
			assert.equal(isChangeButtonDisabled(), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})

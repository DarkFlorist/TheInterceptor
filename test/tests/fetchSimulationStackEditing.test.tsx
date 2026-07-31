import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { FetchSimulationStackModal, FetchSimulationStackRows, type FetchSimulationStackModalState } from '../../app/ts/components/pages/FetchSimulationStack.js'
import { getNativeTokenErc20 } from '../../app/ts/background/metadataUtils.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnsEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { SimulationAndVisualisationResults, SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import { installDomMock } from './domMock.js'

type TestDomNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestDomNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly l?: Record<string, (event: unknown) => unknown>
}

function collectElements(node: TestDomNode | undefined, tagName: string, results: TestDomNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

async function clickElement(element: TestDomNode) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element })
}

const signerAddress = 0x1111111111111111111111111111111111111111n
const contractAddress = 0x2222222222222222222222222222222222222222n
const nameHash = 0x1234n
const labelHash = 0x5678n
const rpcNetwork = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}
const signerEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Signer',
	address: signerAddress,
	entrySource: 'User',
	askForAddressAccess: true,
	useAsActiveAddress: true,
	chainId: 1n,
}
const contractEntry: AddressBookEntry = {
	type: 'contract',
	name: 'ENS Contract',
	address: contractAddress,
	entrySource: 'User',
	chainId: 1n,
}
const nativeTokenEntry = getNativeTokenErc20(rpcNetwork)
const originalRequestParameters = {
	method: 'eth_sendTransaction' as const,
	params: [{
		from: signerAddress,
		to: contractAddress,
		value: 0n,
		input: new Uint8Array(),
	}],
}
const transactionIdentifier = 1n
const created = new Date('2024-01-01T00:00:00.000Z')
const transaction = {
	type: '1559' as const,
	from: signerAddress,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21_000n,
	to: contractAddress,
	value: 0n,
	input: new Uint8Array(),
	chainId: 1n,
	accessList: [],
}
const preSimulationTransaction = {
	signedTransaction: mockSignTransaction(transaction),
	website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
	created,
	originalRequestParameters,
	transactionIdentifier,
}
const ensEvent: EnsEvent = {
	type: 'ENS',
	subType: 'ENSTextChangedKeyValue',
	isParsed: 'Parsed',
	name: 'TextChanged',
	signature: 'TextChanged(bytes32,string,string)',
	args: [],
	address: contractAddress,
	loggersAddressBookEntry: contractEntry,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		node: {
			nameHash,
			name: 'example.eth',
		},
		indexedKey: new Uint8Array([1]),
		key: 'avatar',
		value: 'ipfs://avatar',
	},
}
const ensLabelEvent: EnsEvent = {
	type: 'ENS',
	subType: 'ENSBaseRegistrarNameRegistered',
	isParsed: 'Parsed',
	name: 'NameRegistered',
	signature: 'NameRegistered(uint256,address,uint256)',
	args: [],
	address: contractAddress,
	loggersAddressBookEntry: contractEntry,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		labelHash: {
			labelHash,
			label: 'example',
		},
		owner: signerEntry,
		expires: 2_000_000_000n,
	},
}
const simulatedTransaction: SimulatedAndVisualizedTransaction = {
	website: preSimulationTransaction.website,
	created,
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier,
	originalRequestParameters,
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 21_000n,
	realizedGasPrice: 1n,
	quarantine: false,
	quarantineReasons: [],
	transactionStatus: 'Transaction Succeeded',
	transaction: {
		from: signerEntry,
		to: contractEntry,
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
	events: [ensEvent],
}
const blockTimeManipulation = { type: 'No Delay' as const }
const simulationResults: SimulationAndVisualisationResults = {
	blockNumber: 100n,
	blockTimestamp: created,
	simulationConductedTimestamp: created,
	simulationStateInput: [{
		stateOverrides: {},
		transactions: [preSimulationTransaction],
		signedMessages: [],
		blockTimeManipulation,
		simulateWithZeroBaseFee: false,
	}],
	addressBookEntries: [signerEntry, contractEntry, nativeTokenEntry],
	visualizedSimulationState: {
		success: true,
		visualizedBlocks: [{
			simulatedAndVisualizedTransactions: [simulatedTransaction],
			visualizedPersonalSignRequests: [],
			blockTimeManipulation,
		}],
	},
	rpcNetwork,
	tokenPriceEstimates: [],
	namedTokenIds: [],
}

function replaceEnsEvent(event: EnsEvent): SimulationAndVisualisationResults {
	return {
		...simulationResults,
		visualizedSimulationState: {
			success: true,
			visualizedBlocks: [{
				simulatedAndVisualizedTransactions: [{ ...simulatedTransaction, events: [event] }],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation,
			}],
		},
	}
}

async function renderAndOpenEnsEditor(event: EnsEvent) {
	const dom = installDomMock()
	const modalState = new Signal<FetchSimulationStackModalState>({ page: 'noModal' })

	await act(() => {
		render(h('div', {},
			h(FetchSimulationStackRows, {
				simulationAndVisualisationResults: new Signal(replaceEnsEvent(event)),
				activeAddress: new Signal<bigint | undefined>(signerAddress),
				addressMetaData: new Signal([signerEntry, contractEntry, nativeTokenEntry]),
				renameAddressCallBack: () => undefined,
				modalState,
			}),
			h(FetchSimulationStackModal, {
				modalState,
				rpcEntries: new Signal([rpcNetwork]),
			}),
		), dom.document.body)
	})

	const renameEnsButton = collectElements(dom.document.body, 'button').find((button) => button.getAttribute?.('class')?.split(/\s+/).includes('rename-address-button'))
	if (renameEnsButton === undefined) throw new Error('Expected ENS rename button')

	await act(async () => {
		await clickElement(renameEnsButton)
	})

	return { dom, modalState }
}

async function closeEnsEditor(dom: ReturnType<typeof installDomMock>, modalState: Signal<FetchSimulationStackModalState>) {
	const closeEditorButton = collectElements(dom.document.body, 'button').find((button) => button.textContent?.trim() === 'Ok')
	if (closeEditorButton === undefined) throw new Error('Expected ENS editor close button')

	await act(async () => {
		await clickElement(closeEditorButton)
	})

	assert.deepEqual(modalState.value, { page: 'noModal' })
	await act(() => {
		render(null, dom.document.body)
	})
	dom.restore()
}

describe('FetchSimulationStack editing', () => {
	test('opens the ENS hash editor from a simulation stack event', async () => {
		const { dom, modalState } = await renderAndOpenEnsEditor(ensEvent)

		assert.deepEqual(modalState.value, {
			page: 'editEnsNamedHash',
			state: {
				type: 'nameHash',
				nameHash,
				name: 'example.eth',
			},
		})
		assert.equal(dom.document.body.textContent.includes('What is the correct ENS name for this hash?'), true)
		await closeEnsEditor(dom, modalState)
		assert.equal(dom.document.body.textContent.includes('What is the correct ENS name for this hash?'), false)
	})

	test('opens the ENS label editor from a simulation stack event', async () => {
		const { dom, modalState } = await renderAndOpenEnsEditor(ensLabelEvent)

		assert.deepEqual(modalState.value, {
			page: 'editEnsNamedHash',
			state: {
				type: 'labelHash',
				nameHash: labelHash,
				name: 'example',
			},
		})
		assert.equal(dom.document.body.textContent.includes('What is the correct ENS label for this hash?'), true)
		await closeEnsEditor(dom, modalState)
		assert.equal(dom.document.body.textContent.includes('What is the correct ENS label for this hash?'), false)
	})
})

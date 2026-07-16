import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { SignatureHeader } from '../../app/ts/components/pages/PersonalSign.js'
import { CheckBoxes } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { TransactionHeader } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import { PendingStackHeader } from '../../app/ts/components/simulationExplaining/Transactions.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { SimulatedAndVisualizedTransaction } from '../../app/ts/types/visualizer-types.js'
import type { PopupPendingSignableMessage } from '../../app/ts/types/accessRequest.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	nodeType?: number
	textContent?: string | null
	childNodes?: readonly TestNode[]
	getAttribute?: (name: string) => string | null
}

const website: Website = {
	websiteOrigin: 'https://example.com',
	title: 'Example Website',
	icon: undefined,
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

const fromEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Sender',
	address: 0x1000000000000000000000000000000000000001n,
	entrySource: 'OnChain',
}

const toEntry: AddressBookEntry = {
	type: 'contact',
	name: 'Receiver',
	address: 0x2000000000000000000000000000000000000002n,
	entrySource: 'OnChain',
}

const fallbackMethodTransaction: SimulatedAndVisualizedTransaction = {
	website,
	created: new Date('2024-01-01T00:00:00.000Z'),
	parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
	transactionIdentifier: 1n,
	originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: fromEntry.address, to: toEntry.address, value: 0n, input: new Uint8Array() }] },
	tokenBalancesAfter: [],
	tokenPriceEstimates: [],
	tokenPriceQuoteToken: undefined,
	gasSpent: 0n,
	realizedGasPrice: 1n,
	quarantine: false,
	quarantineReasons: [],
	transactionStatus: 'Transaction Succeeded',
	transaction: {
		from: fromEntry,
		to: toEntry,
		rpcNetwork,
		input: new Uint8Array(),
		value: 0n,
		gas: 21000n,
		type: '1559',
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
		nonce: 1n,
		hash: 1n,
	},
	events: [],
}

const personalSignRequest: VisualizedPersonalSignRequest = {
	method: 'personal_sign',
	type: 'NotParsed',
	message: 'hello',
	messageHash: '0x1',
	simulationMode: false,
	signerName: 'NoSigner',
	requestAccessToAddress: false,
	activeAddress: fromEntry.address,
	quarantineReasons: [],
	quarantine: false,
	account: fromEntry,
	website,
	created: new Date('2024-01-01T00:00:00.000Z'),
	rawMessage: 'hello',
	stringifiedMessage: 'hello',
	messageIdentifier: 2n,
}

function hasClass(node: TestNode | undefined, className: string) {
	const classes = node?.getAttribute?.('class')?.split(/\s+/).filter((value) => value !== '') ?? []
	return classes.includes(className)
}

function findFirstByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node === undefined) return undefined
	if (hasClass(node, className)) return node
	for (const child of node.childNodes ?? []) {
		const match = findFirstByClass(child, className)
		if (match !== undefined) return match
	}
	return undefined
}

function assertClasses(node: TestNode | undefined, expectedClasses: string[]) {
	assert.notEqual(node, undefined)
	for (const expectedClass of expectedClasses) {
		assert.equal(hasClass(node, expectedClass), true, `expected class ${ expectedClass }`)
	}
}

describe('popup header markup', () => {
	test('TransactionHeader renders the fallback title inside the ellipsis target and composes the flush website class', async () => {
		const dom = installDomMock()

		await act(() => {
			render(h(TransactionHeader, {
				simTx: fallbackMethodTransaction,
				removeTransactionOrSignedMessage: () => undefined,
			}), dom.document.body)
		})

		const titleText = findFirstByClass(dom.document.body, 'card-header-title-text')
		assert.equal(titleText?.textContent, 'Contract Fallback Method')
		assertClasses(findFirstByClass(dom.document.body, 'card-header-website'), ['card-header-website', 'card-header-website--flush'])

		dom.restore()
	})

	test('SignatureHeader renders the title inside the ellipsis target and composes the flush website class', async () => {
		const dom = installDomMock()

		await act(() => {
			render(h(SignatureHeader, {
				visualizedPersonalSignRequest: personalSignRequest,
				removeTransactionOrSignedMessage: () => undefined,
			}), dom.document.body)
		})

		const titleText = findFirstByClass(dom.document.body, 'card-header-title-text')
		assert.notEqual(titleText?.textContent?.length, 0)
		assertClasses(findFirstByClass(dom.document.body, 'card-header-website'), ['card-header-website', 'card-header-website--flush'])

		dom.restore()
	})

	test('signable message signer errors render the wallet delivery failure', async () => {
		const dom = installDomMock()
		const message = 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.'
		const pendingMessage: PopupPendingSignableMessage = {
			type: 'SignableMessage',
			popupOrTabId: { type: 'popup', id: 1 },
			originalRequestParameters: { method: 'personal_sign', params: ['hello', fromEntry.address] },
			simulationMode: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
			created: personalSignRequest.created,
			website,
			activeAddress: fromEntry.address,
			approvalStatus: { status: 'SignerError', code: -32603, message },
			transactionOrMessageCreationStatus: 'Simulated',
			visualizedPersonalSignRequest: personalSignRequest,
		}

		await act(() => {
			render(h(CheckBoxes, {
				currentPendingTransactionOrSignableMessage: new Signal(pendingMessage),
				forceSend: new Signal(false),
			}), dom.document.body)
		})

		assert.match(dom.document.body.textContent ?? '', /request reached your wallet/)
		dom.restore()
	})

	test('PendingStackHeader renders its title inside the ellipsis target', async () => {
		const dom = installDomMock()

		await act(() => {
			render(h(PendingStackHeader, {
				title: 'Pending stack row title',
				website,
				statusIcon: '../img/question-mark-sign.svg',
			}), dom.document.body)
		})

		const titleText = findFirstByClass(dom.document.body, 'card-header-title-text')
		assert.equal(titleText?.textContent, 'Pending stack row title')

		dom.restore()
	})
})

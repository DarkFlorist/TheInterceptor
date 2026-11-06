import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { type ComponentChildren, render } from 'preact'
import { act } from 'preact/test-utils'
import { SignatureCard } from '../../app/ts/components/pages/PersonalSign.js'
import { TransactionInput } from '../../app/ts/components/subcomponents/ParsedInputData.js'
import { ViewSelector } from '../../app/ts/components/subcomponents/ViewSelector.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { clickRenderedElement, installDomMock, type RenderedTreeNode } from './domMock.js'

const signerEntry: AddressBookEntry = { type: 'contact', name: 'Signer', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User', chainId: 1n }
const rpcNetwork: RpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }

const personalSignRequest = (messageIdentifier: bigint): VisualizedPersonalSignRequest => ({
	method: 'personal_sign',
	type: 'NotParsed',
	message: 'Hello Interceptor',
	messageHash: '0x1',
	simulationMode: true,
	signerName: 'NoSigner',
	activeAddress: signerEntry,
	rpcNetwork,
	quarantineReasons: [],
	quarantine: false,
	account: signerEntry,
	website: { websiteOrigin: 'https://example.test', title: 'Example', icon: undefined },
	created: new Date('2024-01-01T00:00:00.000Z'),
	rawMessage: 'Hello Interceptor',
	stringifiedMessage: 'Hello Interceptor',
	messageIdentifier,
})

const typedDataRequest = (messageIdentifier: bigint): VisualizedPersonalSignRequest => ({
	...personalSignRequest(messageIdentifier),
	method: 'eth_signTypedData_v4',
	type: 'EIP712',
	message: { primaryType: 'Mail', message: {}, domain: {} },
	messageHash: '0x1',
	domainHash: '0x2',
})

const signatureCard = (visualizedPersonalSignRequest: VisualizedPersonalSignRequest) => <SignatureCard
	visualizedPersonalSignRequest = { visualizedPersonalSignRequest }
	renameAddressCallBack = { () => undefined }
	editEnsNamedHashCallBack = { () => undefined }
	removeTransactionOrSignedMessage = { undefined }
	numberOfUnderTransactions = { 0 }
/>

const transactionInput = () => <TransactionInput input = { new Uint8Array([0xde, 0xad, 0xbe, 0xef]) } to = { undefined } addressMetaData = { [] } renameAddressCallBack = { () => undefined } />

const viewSelector = (id: string) => <ViewSelector id = { id }>
	<ViewSelector.List>
		<ViewSelector.View title = 'Parsed' value = 'parsed' isActive = { true }>Parsed content</ViewSelector.View>
		<ViewSelector.View title = 'Raw' value = 'raw' isActive = { false }>Raw content</ViewSelector.View>
	</ViewSelector.List>
	<ViewSelector.Triggers />
</ViewSelector>

function collectRenderedElements(node: RenderedTreeNode, matches: (node: RenderedTreeNode) => boolean): RenderedTreeNode[] {
	const matchingDescendants = (node.childNodes ?? []).flatMap((child) => collectRenderedElements(child, matches))
	return matches(node) ? [node, ...matchingDescendants] : matchingDescendants
}

function getRadioGroupNamePerSelector(body: RenderedTreeNode) {
	const selectors = collectRenderedElements(body, (node) => node.attributes?.class?.split(' ').includes('view-selector') === true)
	return selectors.map((selector) => {
		const radios = collectRenderedElements(selector, (node) => node.tagName === 'INPUT' && node.attributes?.type === 'radio')
		assert.equal(radios.length, 2)
		const [radioGroupName, ...otherRadioGroupNames] = [...new Set(radios.map((radio) => radio.attributes?.name))]
		assert.deepEqual(otherRadioGroupNames, [], 'the radios of one selector must stay in one group to remain mutually exclusive')
		return radioGroupName
	})
}

async function expandRawMessageCards(body: RenderedTreeNode) {
	const isRawMessageHeader = (node: RenderedTreeNode) => node.tagName === 'HEADER' && node.textContent?.includes('Raw message') === true
	for (const header of collectRenderedElements(body, isRawMessageHeader)) await act(async () => await clickRenderedElement(header))
}

// Browsers keep one checked radio per document-wide name, so stacked cards rendering the same selector must not share a name.
const stackedCardGroups: readonly { group: string, renderStackedCards: () => ComponentChildren }[] = [
	{ group: 'personal_sign', renderStackedCards: () => [1n, 2n, 3n].map((identifier) => signatureCard(personalSignRequest(identifier))) },
	{ group: 'raw_message', renderStackedCards: () => [1n, 2n, 3n].map((identifier) => signatureCard(typedDataRequest(identifier))) },
	{ group: 'transaction_input', renderStackedCards: () => [transactionInput(), transactionInput(), transactionInput()] },
]

describe('ViewSelector radio groups', () => {
	for (const { group, renderStackedCards } of stackedCardGroups) test(`gives each stacked ${ group } selector its own radio group`, async () => {
		const dom = installDomMock()
		try {
			await act(() => render(<div>{ renderStackedCards() }</div>, dom.document.body))
			await expandRawMessageCards(dom.document.body)

			const radioGroupNames = getRadioGroupNamePerSelector(dom.document.body)
			assert.equal(radioGroupNames.length, 3)
			assert.equal(new Set(radioGroupNames).size, 3, `expected unique radio group names, got ${ radioGroupNames.join(', ') }`)
			assert.equal(radioGroupNames.every((radioGroupName) => radioGroupName?.startsWith(`${ group }-`)), true, `expected ${ group } selectors, got ${ radioGroupNames.join(', ') }`)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps a selector radio group name stable across re-renders', async () => {
		const dom = installDomMock()
		const selectors = () => <div>{ viewSelector('stable') }{ viewSelector('stable') }</div>
		try {
			await act(() => render(selectors(), dom.document.body))
			const initialRadioGroupNames = getRadioGroupNamePerSelector(dom.document.body)

			await act(() => render(selectors(), dom.document.body))
			assert.deepEqual(getRadioGroupNamePerSelector(dom.document.body), initialRadioGroupNames)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})

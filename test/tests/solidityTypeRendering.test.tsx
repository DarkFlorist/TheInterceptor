import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { NoParsedAvailable } from '../../app/ts/components/subcomponents/ParsedInputData.js'
import { EnrichedSolidityTypeComponentWithAddressBook } from '../../app/ts/components/subcomponents/solidityType.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { PureGroupedSolidityType } from '../../app/ts/types/solidityType.js'
import { installDomMock } from './domMock.js'

type RenderTreeNode = {
	readonly childNodes?: readonly RenderTreeNode[]
	readonly style?: { readonly cssText?: string }
	readonly textContent?: string
}

const SEAPORT_TOKEN_ADDRESS = 0x6000000000000000000000000000000000000006n
const CONSIDERATION_RECIPIENT_ADDRESS = 0x7000000000000000000000000000000000000007n

const noopRename = () => undefined

const normalizeRenderedText = (text: string | undefined) => (text ?? '').replace(/\s+/gu, ' ').trim()

const collectNodesWithStyle = (node: RenderTreeNode, styleText: string): readonly RenderTreeNode[] => {
	const matches = node.style?.cssText?.includes(styleText) === true ? [node] : []
	for (const child of node.childNodes ?? []) {
		matches.push(...collectNodesWithStyle(child, styleText))
	}
	return matches
}

const addressMetaData = [
	{
		type: 'ERC20',
		name: 'Seaport Token',
		symbol: 'SEA',
		decimals: 18n,
		address: SEAPORT_TOKEN_ADDRESS,
		entrySource: 'User',
	},
	{
		type: 'contact',
		name: 'Fee Recipient',
		address: CONSIDERATION_RECIPIENT_ADDRESS,
		entrySource: 'User',
	},
] satisfies readonly AddressBookEntry[]

const web3jAbiV2Tuple = {
	type: 'tuple',
	value: [
		{ paramName: 'id', typeValue: { type: 'string', value: 'foo-id' } },
		{ paramName: 'name', typeValue: { type: 'string', value: 'Example Foo' } },
	],
} satisfies PureGroupedSolidityType

const seaportTupleArray = {
	type: 'tuple[]',
	value: [
		[
			{ paramName: 'itemType', typeValue: { type: 'unsignedInteger', value: 2n } },
			{ paramName: 'token', typeValue: { type: 'address', value: SEAPORT_TOKEN_ADDRESS } },
			{ paramName: 'identifier', typeValue: { type: 'unsignedInteger', value: 123n } },
			{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 1n } },
		],
		[
			{ paramName: 'itemType', typeValue: { type: 'unsignedInteger', value: 0n } },
			{ paramName: 'token', typeValue: { type: 'address', value: 0n } },
			{ paramName: 'identifier', typeValue: { type: 'unsignedInteger', value: 0n } },
			{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 100n } },
			{ paramName: 'recipient', typeValue: { type: 'address', value: CONSIDERATION_RECIPIENT_ADDRESS } },
		],
	],
} satisfies PureGroupedSolidityType

describe('Solidity type rendering', () => {
	test('renders generic unavailable input parser copy after tuple support', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(NoParsedAvailable, {
					to: {
						type: 'contract',
						name: 'Tuple Input Contract',
						address: 0x9000000000000000000000000000000000000009n,
						entrySource: 'User',
						abi: '[]',
					},
					renameAddressCallBack: noopRename,
				}), dom.document.body)
			})

			const renderedText = normalizeRenderedText(dom.document.body.textContent)
			assert.equal(renderedText.includes('Unable to parse input data with the available ABI for Tuple Input Contract'), true)
			assert.equal(renderedText.includes('struct'), false)
		} finally {
			dom.restore()
		}
	})

	test('renders Web3j ABIv2 struct fields with braces and labels', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(EnrichedSolidityTypeComponentWithAddressBook, {
					valueType: web3jAbiV2Tuple,
					addressMetaData: [],
					renameAddressCallBack: noopRename,
				}), dom.document.body)
			})

			const renderedText = normalizeRenderedText(dom.document.body.textContent)
			assert.equal(renderedText, '{ id = "foo-id", name = "Example Foo"}')
			assert.equal(collectNodesWithStyle(dom.document.body, 'gap: 0 0.25em').length, 1)
			assert.equal(collectNodesWithStyle(dom.document.body, 'gap: 0 0.125em').length, 2)
		} finally {
			dom.restore()
		}
	})

	test('renders Seaport tuple arrays with grouped struct fields and address labels', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(EnrichedSolidityTypeComponentWithAddressBook, {
					valueType: seaportTupleArray,
					addressMetaData,
					renameAddressCallBack: noopRename,
				}), dom.document.body)
			})

			const renderedText = normalizeRenderedText(dom.document.body.textContent)
			assert.equal(renderedText.includes('[{ itemType = 2'), true)
			assert.equal(renderedText.includes('token = Seaport Token'), true)
			assert.equal(renderedText.includes('identifier = 123'), true)
			assert.equal(renderedText.includes('amount = 1}'), true)
			assert.equal(renderedText.includes('{ itemType = 0'), true)
			assert.equal(renderedText.includes('amount = 100'), true)
			assert.equal(renderedText.includes('recipient = Fee Recipient'), true)
			assert.equal(collectNodesWithStyle(dom.document.body, 'gap: 0 0.25em').length, 2)
			assert.equal(collectNodesWithStyle(dom.document.body, 'gap: 0 0.125em').length, 9)
		} finally {
			dom.restore()
		}
	})
})

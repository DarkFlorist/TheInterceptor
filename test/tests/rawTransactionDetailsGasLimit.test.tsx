import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { RawTransactionDetailsCard } from '../../app/ts/components/simulationExplaining/SimulationSummary.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'

const senderEntry: ContactEntry = {
	type: 'contact',
	name: 'Batch sender',
	address: 0x1111111111111111111111111111111111111111n,
	entrySource: 'User',
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

async function renderExpandedRawTransactionDetails(gasLimitEditable: boolean | undefined) {
	const dom = installDomMock()
	await act(() => {
		render(h(RawTransactionDetailsCard, {
			isRawTransaction: false,
			transaction: {
				from: senderEntry,
				to: senderEntry,
				value: 0n,
				input: new Uint8Array(),
				rpcNetwork,
				hash: 0x1234n,
				gas: 21_000n,
				nonce: 7n,
				type: '1559',
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
			},
			transactionIdentifier: 1n,
			parsedInputData: { type: 'NonParsed', input: new Uint8Array() },
			renameAddressCallBack: () => undefined,
			gasSpent: undefined,
			addressMetaData: new Signal([senderEntry]),
			...(gasLimitEditable === undefined ? {} : { gasLimitEditable }),
		}), dom.document.body)
	})
	const header = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes('Raw transaction information') === true)
	if (header === undefined) throw new Error('Missing raw transaction details header')
	await act(async () => { await clickRenderedElement(header) })
	return dom
}

describe('RawTransactionDetailsCard gas limit', () => {
	test('lets single transactions change their gas limit', async () => {
		const dom = await renderExpandedRawTransactionDetails(undefined)
		assert.equal(findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent?.includes('Change') === true) !== undefined, true)
		render(null, dom.document.body)
		dom.restore()
	})

	test('shows a read-only gas limit for wallet_sendCalls batch calls', async () => {
		const dom = await renderExpandedRawTransactionDetails(false)
		assert.equal(findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent?.includes('Change') === true), undefined)
		assert.equal(dom.document.body.textContent?.includes('21000 gas'), true)
		render(null, dom.document.body)
		dom.restore()
	})
})

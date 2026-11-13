import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import type { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import type { TokenVisualizerResultWithMetadata } from '../../app/ts/types/EnrichedEthereumData.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { SimpleTokenApprovalVisualisation } from '../../app/ts/components/simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { installDomMock } from './domMock.js'

const rpcNetwork: RpcNetwork = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: undefined, currencyName: 'Ether', currencyTicker: 'ETH' }
const owner: AddressBookEntry = { type: 'contact', name: 'Owner', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User' }
const spender: AddressBookEntry = { type: 'contact', name: 'Approved Spender', address: 0x2222222222222222222222222222222222222222n, entrySource: 'User' }
const erc20Token: Erc20TokenEntry = { type: 'ERC20', name: 'USD Coin', symbol: 'USDC', decimals: 6n, address: 0x3333333333333333333333333333333333333333n, entrySource: 'User', chainId: 1n }
const erc721Token: Erc721Entry = { type: 'ERC721', name: 'Samurai', symbol: 'SAM', address: 0x4444444444444444444444444444444444444444n, entrySource: 'User', chainId: 1n }
const erc1155Token: Erc1155Entry = { type: 'ERC1155', name: 'Items', symbol: 'ITM', decimals: undefined, address: 0x5555555555555555555555555555555555555555n, entrySource: 'User', chainId: 1n }
const simulatedEvent = { from: owner, to: spender, logObject: undefined }

async function renderApprovalText(approval: TokenVisualizerResultWithMetadata) {
	const dom = installDomMock()
	try {
		await act(() => {
			render(h(SimpleTokenApprovalVisualisation, { approval, transactionGasses: { gasSpent: 21000n, realizedGasPrice: 1000000000n }, rpcNetwork, renameAddressCallBack: () => undefined }), dom.document.body)
		})
		const text = dom.document.body.textContent ?? ''
		await act(() => { render(null, dom.document.body) })
		return text
	} finally {
		dom.restore()
	}
}

describe('SimpleTokenApprovalVisualisation', () => {
	const approvals: readonly { readonly approval: TokenVisualizerResultWithMetadata, readonly expectedText: readonly string[] }[] = [
		{ approval: { ...simulatedEvent, type: 'ERC20', token: erc20Token, amount: 2500000n, isApproval: true }, expectedText: ['2.5', 'USDC'] },
		{ approval: { ...simulatedEvent, type: 'ERC20', token: erc20Token, amount: 2n ** 96n - 1n, isApproval: true }, expectedText: ['ALL', 'USDC'] },
		{ approval: { ...simulatedEvent, type: 'ERC721', token: erc721Token, tokenId: 7n, isApproval: true }, expectedText: ['SAM', '#7'] },
		{ approval: { ...simulatedEvent, type: 'NFT All approval', token: erc721Token, allApprovalAdded: true, isApproval: true }, expectedText: ['ALL', 'SAM'] },
		{ approval: { ...simulatedEvent, type: 'NFT All approval', token: erc1155Token, allApprovalAdded: false, isApproval: true }, expectedText: ['NONE', 'ITM'] },
	]

	test('shows the spender, the approved token and the gas fee of a simulated approval', async () => {
		for (const { approval, expectedText } of approvals) {
			const text = await renderApprovalText(approval)
			for (const expected of ['Allow', 'Approved Spender', 'To Spend', 'Gas fee:', '0.000021', ...expectedText]) assert.equal(text.includes(expected), true, `Expected "${ expected }" in "${ text }"`)
		}
	})
})

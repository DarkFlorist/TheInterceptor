import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { AddNewAddress } from '../../app/ts/components/pages/AddNewAddress.js'
import { TokenSymbol } from '../../app/ts/components/subcomponents/coins.js'
import type { Erc1155Entry, Erc20TokenEntry, Erc721Entry, EntrySource } from '../../app/ts/types/addressBookTypes.js'
import type { ModifyAddressWindowState } from '../../app/ts/types/visualizer-types.js'
import { getOnChainTokenWarning, ON_CHAIN_TOKEN_IDENTITY_WARNING, ON_CHAIN_TOKEN_METADATA_WARNING } from '../../app/ts/components/subcomponents/onChainTokenWarnings.js'
import { getUnverifiedOnChainTokenLabel, requiresOnChainTokenMetadataConfirmation } from '../../app/ts/utils/onChainTokenMetadata.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => unknown
	readonly textContent?: string
}

const tokenAddress = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n

const createErc20Entry = (entrySource: EntrySource): Erc20TokenEntry => ({ type: 'ERC20', name: 'USD Coin', symbol: 'USDC', address: tokenAddress, decimals: 6n, entrySource })
const createErc721Entry = (entrySource: EntrySource): Erc721Entry => ({ type: 'ERC721', name: 'Example NFT', symbol: 'NFT', address: tokenAddress, entrySource })
const createErc1155Entry = (entrySource: EntrySource): Erc1155Entry => ({ type: 'ERC1155', name: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: '???', address: tokenAddress, decimals: undefined, entrySource })

function collectWarningSigns(node: TestNode | undefined, results: TestNode[] = []) {
	if (node?.getAttribute?.('class') === 'inline-card-warning-sign') results.push(node)
	for (const child of node?.childNodes ?? []) collectWarningSigns(child, results)
	return results
}

async function renderTokenSymbolWarningSigns(tokenEntry: Erc20TokenEntry | Erc721Entry | Erc1155Entry) {
	const dom = installDomMock()
	try {
		await act(() => {
			render(tokenEntry.type === 'ERC20'
				? <TokenSymbol tokenEntry = { tokenEntry } renameAddressCallBack = { () => undefined } fontSize = 'normal' />
				: <TokenSymbol tokenEntry = { tokenEntry } tokenId = { undefined } renameAddressCallBack = { () => undefined } fontSize = 'normal' />, dom.document.body)
		})
		return collectWarningSigns(dom.document.body)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
}

const createTokenEditWindowState = (type: 'ERC20' | 'ERC1155', entrySource: EntrySource): ModifyAddressWindowState => ({
	windowStateId: 'edit-token-window',
	errorState: undefined,
	incompleteAddressBookEntry: {
		addingAddress: false,
		type,
		address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		askForAddressAccess: true,
		name: type === 'ERC20' ? 'USD Coin' : '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		symbol: type === 'ERC20' ? 'USDC' : '???',
		decimals: type === 'ERC20' ? 6n : undefined,
		logoUri: undefined,
		entrySource,
		abi: undefined,
		useAsActiveAddress: undefined,
		declarativeNetRequestBlockMode: undefined,
		chainId: 1n,
	},
})

async function renderEditDialogText(type: 'ERC20' | 'ERC1155', entrySource: EntrySource) {
	installBrowserMock()
	const dom = installDomMock()
	try {
		await act(() => {
			render(<AddNewAddress
				close = { () => undefined }
				setActiveAddressAndInformAboutIt = { undefined }
				modifyAddressWindowState = { signal(createTokenEditWindowState(type, entrySource)) }
				activeAddress = { undefined }
				rpcEntries = { signal([]) }
			/>, dom.document.body)
		})
		return dom.document.body.textContent
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
}

describe('on-chain token warnings', () => {
	test('classifies what labels each on-chain token entry without verification', () => {
		assert.equal(getUnverifiedOnChainTokenLabel(createErc20Entry('OnChain')), 'tokenProvidedNameAndSymbol')
		assert.equal(getUnverifiedOnChainTokenLabel(createErc721Entry('OnChain')), 'tokenProvidedNameAndSymbol')
		assert.equal(getUnverifiedOnChainTokenLabel(createErc1155Entry('OnChain')), 'addressOnly')
		for (const type of ['contact', 'contract', 'safe'] as const) assert.equal(getUnverifiedOnChainTokenLabel({ type, entrySource: 'OnChain' }), undefined)
		for (const entrySource of ['User', 'DarkFloristMetadata', 'Interceptor', 'FilledIn'] as const) assert.equal(getUnverifiedOnChainTokenLabel(createErc1155Entry(entrySource)), undefined)
	})

	test('asks the user to confirm token-provided names only for on-chain ERC20 and ERC721 entries', () => {
		assert.equal(requiresOnChainTokenMetadataConfirmation(createErc20Entry('OnChain')), true)
		assert.equal(requiresOnChainTokenMetadataConfirmation(createErc721Entry('OnChain')), true)
		assert.equal(requiresOnChainTokenMetadataConfirmation(createErc1155Entry('OnChain')), false)
		assert.equal(requiresOnChainTokenMetadataConfirmation({ type: 'contract', entrySource: 'OnChain' }), false)
		assert.equal(requiresOnChainTokenMetadataConfirmation({ type: 'contact', entrySource: 'OnChain' }), false)
		for (const entrySource of ['User', 'DarkFloristMetadata', 'Interceptor', 'FilledIn'] as const) assert.equal(requiresOnChainTokenMetadataConfirmation(createErc20Entry(entrySource)), false)
	})

	test('picks a warning sign message that matches what each on-chain token type displays', () => {
		assert.equal(getOnChainTokenWarning(createErc20Entry('OnChain')), ON_CHAIN_TOKEN_METADATA_WARNING)
		assert.equal(getOnChainTokenWarning(createErc721Entry('OnChain')), ON_CHAIN_TOKEN_METADATA_WARNING)
		assert.equal(getOnChainTokenWarning(createErc1155Entry('OnChain')), ON_CHAIN_TOKEN_IDENTITY_WARNING)
		assert.equal(getOnChainTokenWarning({ type: 'contract', entrySource: 'OnChain' }), undefined)
		assert.equal(getOnChainTokenWarning({ type: 'contact', entrySource: 'OnChain' }), undefined)
		for (const entrySource of ['User', 'DarkFloristMetadata', 'Interceptor', 'FilledIn'] as const) {
			assert.equal(getOnChainTokenWarning(createErc20Entry(entrySource)), undefined)
			assert.equal(getOnChainTokenWarning(createErc721Entry(entrySource)), undefined)
			assert.equal(getOnChainTokenWarning(createErc1155Entry(entrySource)), undefined)
		}
	})

	test('announces the explanation as an alert once and shows it as a tooltip on warning signs of on-chain tokens', async () => {
		const expectedMessages = [
			[createErc20Entry('OnChain'), ON_CHAIN_TOKEN_METADATA_WARNING],
			[createErc721Entry('OnChain'), ON_CHAIN_TOKEN_METADATA_WARNING],
			[createErc1155Entry('OnChain'), ON_CHAIN_TOKEN_IDENTITY_WARNING],
		] as const
		for (const [tokenEntry, expectedMessage] of expectedMessages) {
			const warningSigns = await renderTokenSymbolWarningSigns(tokenEntry)
			assert.equal(warningSigns.length, 2)
			assert.equal(warningSigns.every((warningSign) => warningSign.getAttribute?.('data-warning-tooltip') === expectedMessage), true)
			const [leadingSign, trailingSign] = warningSigns
			assert.equal(leadingSign?.getAttribute?.('role'), 'alert')
			assert.equal(leadingSign?.getAttribute?.('aria-label'), expectedMessage)
			assert.equal(trailingSign?.getAttribute?.('role'), null)
			assert.equal(trailingSign?.getAttribute?.('aria-hidden'), true)
		}
	})

	test('does not show warning signs for tokens from trusted sources', async () => {
		for (const tokenEntry of [createErc20Entry('User'), createErc20Entry('DarkFloristMetadata'), createErc1155Entry('User')]) {
			assert.deepEqual(await renderTokenSymbolWarningSigns(tokenEntry), [])
		}
	})

	test('shows the same explanation in the token edit dialog without adding a confirmation for ERC1155 tokens', async () => {
		assert.equal((await renderEditDialogText('ERC20', 'OnChain'))?.includes(ON_CHAIN_TOKEN_METADATA_WARNING), true)
		assert.equal((await renderEditDialogText('ERC20', 'User'))?.includes(ON_CHAIN_TOKEN_METADATA_WARNING), false)
		const erc1155DialogText = await renderEditDialogText('ERC1155', 'OnChain')
		assert.equal(erc1155DialogText?.includes(ON_CHAIN_TOKEN_METADATA_WARNING), false)
		assert.equal(erc1155DialogText?.includes(ON_CHAIN_TOKEN_IDENTITY_WARNING), false)
	})
})

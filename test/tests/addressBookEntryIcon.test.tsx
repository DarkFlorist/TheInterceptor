import * as assert from 'assert'
import { render } from 'preact'
import type { JSX } from 'preact/jsx-runtime'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { TokenSymbol } from '../../app/ts/components/subcomponents/coins.js'
import { SmallAddress } from '../../app/ts/components/subcomponents/address.js'
import type { AddressBookEntry, Erc20TokenEntry, Erc721Entry } from '../../app/ts/types/addressBookTypes.js'
import { readInterceptorAppCss } from './cssTestUtils.js'
import { installDomMock } from './domMock.js'

type RenderTreeNode = {
	readonly childNodes?: readonly RenderTreeNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly textContent?: string
	readonly style?: Record<string, string>
}

type RenderedIcon =
	| { readonly kind: 'ticker', readonly text: string | undefined, readonly backgroundColor: string | undefined, readonly className: string | undefined }
	| { readonly kind: 'blockie' }
	| { readonly kind: 'logo', readonly src: string | undefined }

const USDC_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const SAME_SYMBOL_TOKEN_ADDRESS = 0x1111111111111111111111111111111111111111n
const NFT_COLLECTION_ADDRESS = 0x2222222222222222222222222222222222222222n

const collectElements = (node: RenderTreeNode, tagName: string): readonly RenderTreeNode[] => [
	...(node.tagName === tagName.toUpperCase() ? [node] : []),
	...(node.childNodes ?? []).flatMap((child) => collectElements(child, tagName)),
]

const createErc20Entry = (overrides: Partial<Erc20TokenEntry> = {}): Erc20TokenEntry => ({
	type: 'ERC20',
	name: 'USD Coin',
	symbol: 'USDC',
	decimals: 6n,
	address: USDC_ADDRESS,
	entrySource: 'DarkFloristMetadata',
	...overrides,
})

function readFirstIcon(container: RenderTreeNode): RenderedIcon {
	const iconSlot = collectElements(container, 'span').find((element) => element.getAttribute?.('role') === 'img')
	if (iconSlot === undefined) throw new Error('Expected an icon slot')
	const [image] = collectElements(iconSlot, 'img')
	if (image !== undefined) return { kind: 'logo', src: image.getAttribute?.('src') ?? undefined }
	const tickerIcon = collectElements(iconSlot, 'span').find((element) => element.getAttribute?.('class')?.split(' ').includes('token-ticker-icon') === true)
	if (tickerIcon !== undefined) {
		return {
			kind: 'ticker',
			text: tickerIcon.getAttribute?.('data-ticker-text') ?? undefined,
			backgroundColor: tickerIcon.style?.['backgroundColor'],
			className: tickerIcon.getAttribute?.('class') ?? undefined,
		}
	}
	if (collectElements(iconSlot, 'rect').length > 0) return { kind: 'blockie' }
	throw new Error('Expected a logo, ticker icon or Blockie')
}

async function renderIntoDom<T>(element: JSX.Element, read: (container: RenderTreeNode) => T) {
	const dom = installDomMock()
	try {
		await act(() => {
			render(element, dom.document.body)
		})
		return read(dom.document.body)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
}

const renderFirstIcon = async (element: JSX.Element) => await renderIntoDom(element, readFirstIcon)
const createTokenSymbol = (tokenEntry: Erc20TokenEntry) => <TokenSymbol tokenEntry = { tokenEntry } renameAddressCallBack = { () => undefined } fontSize = 'normal' />
const renderTokenSymbolIcon = async (tokenEntry: Erc20TokenEntry) => await renderFirstIcon(createTokenSymbol(tokenEntry))

describe('address book entry icons', () => {
	test('shows an address-colored ticker icon for trusted tokens without a logo', async () => {
		for (const entrySource of ['DarkFloristMetadata', 'User', 'Interceptor'] as const) {
			const icon = await renderTokenSymbolIcon(createErc20Entry({ entrySource }))
			assert.equal(icon.kind, 'ticker', entrySource)
			if (icon.kind !== 'ticker') continue
			assert.equal(icon.text, 'US')
			assert.match(icon.backgroundColor ?? '', /^hsl\(\d+, 60%, 75%\)$/u)
		}
	})

	test('gives tokens with the same symbol different ticker colors when their addresses differ', async () => {
		const usdcIcon = await renderTokenSymbolIcon(createErc20Entry())
		const sameSymbolIcon = await renderTokenSymbolIcon(createErc20Entry({ address: SAME_SYMBOL_TOKEN_ADDRESS, entrySource: 'User' }))
		const usdcIconAgain = await renderTokenSymbolIcon(createErc20Entry())
		if (usdcIcon.kind !== 'ticker' || sameSymbolIcon.kind !== 'ticker' || usdcIconAgain.kind !== 'ticker') throw new Error('Expected ticker icons')
		assert.equal(usdcIcon.text, sameSymbolIcon.text)
		assert.notEqual(usdcIcon.backgroundColor, sameSymbolIcon.backgroundColor)
		assert.equal(usdcIcon.backgroundColor, usdcIconAgain.backgroundColor)
	})

	test('keeps the address-derived Blockie for untrusted on-chain and filled-in tokens', async () => {
		assert.deepEqual(await renderTokenSymbolIcon(createErc20Entry({ entrySource: 'OnChain' })), { kind: 'blockie' })
		assert.deepEqual(await renderTokenSymbolIcon(createErc20Entry({ entrySource: 'FilledIn' })), { kind: 'blockie' })
	})

	test('keeps showing the logo for tokens that have one', async () => {
		for (const entrySource of ['DarkFloristMetadata', 'OnChain'] as const) {
			assert.deepEqual(await renderTokenSymbolIcon(createErc20Entry({ entrySource, logoUri: 'https://logo.example/usdc.png' })), { kind: 'logo', src: 'https://logo.example/usdc.png' })
		}
	})

	test('falls back to the Blockie when the symbol has no letters or digits to show', async () => {
		for (const symbol of ['', '   ', '???', '🦄', '$.-', 'ΞΞ', '\u212A', '\u017F']) {
			assert.deepEqual(await renderTokenSymbolIcon(createErc20Entry({ symbol })), { kind: 'blockie' }, JSON.stringify(symbol))
		}
	})

	test('shows at most two uppercase ASCII letters or digits from the symbol', async () => {
		const tickerTextBySymbol = { ' $wstETH ': 'WS', '1INCH': '1I', 'u': 'U', '🦄UNI': 'UN', 'VERYLONGTOKENSYMBOL': 'VE' }
		for (const [symbol, expectedText] of Object.entries(tickerTextBySymbol)) {
			const icon = await renderTokenSymbolIcon(createErc20Entry({ symbol }))
			assert.equal(icon.kind === 'ticker' ? icon.text : icon.kind, expectedText, JSON.stringify(symbol))
		}
		const singleCharacterIcon = await renderTokenSymbolIcon(createErc20Entry({ symbol: 'u' }))
		const twoCharacterIcon = await renderTokenSymbolIcon(createErc20Entry({ symbol: 'UNI' }))
		assert.equal(singleCharacterIcon.kind === 'ticker' ? singleCharacterIcon.className : singleCharacterIcon.kind, 'token-ticker-icon token-ticker-icon--single-character')
		assert.equal(twoCharacterIcon.kind === 'ticker' ? twoCharacterIcon.className : twoCharacterIcon.kind, 'token-ticker-icon')
	})

	test('keeps ticker letters out of the rendered text so copied labels stay unchanged', async () => {
		const iconSlotTexts = await renderIntoDom(createTokenSymbol(createErc20Entry()), (container) => collectElements(container, 'span').filter((element) => element.getAttribute?.('role') === 'img').map((element) => element.textContent))
		assert.ok(iconSlotTexts.length > 0)
		assert.deepEqual(iconSlotTexts.filter((text) => text !== ''), [])
	})

	test('draws the ticker letters from the data attribute inside a 1em circle', async () => {
		const css = await readInterceptorAppCss()
		const iconRule = css.match(/\.token-ticker-icon \{([\s\S]*?)\n\}/u)?.[1] ?? ''
		assert.match(iconRule, /border-radius: 50%;/u)
		assert.match(iconRule, /width: 1em;/u)
		assert.match(iconRule, /height: 1em;/u)
		assert.match(iconRule, /color: var\(--black-color\);/u)
		assert.match(css, /\.token-ticker-icon::before \{[^}]*content: attr\(data-ticker-text\);/u)
	})

	test('shows a ticker icon for trusted NFT collections', async () => {
		const nftEntry: Erc721Entry = { type: 'ERC721', name: 'Example Collection', symbol: 'EXC', address: NFT_COLLECTION_ADDRESS, entrySource: 'User' }
		const nftIcon = await renderFirstIcon(<TokenSymbol tokenEntry = { nftEntry } tokenId = { 1n } renameAddressCallBack = { () => undefined } fontSize = 'normal' />)
		assert.equal(nftIcon.kind === 'ticker' ? nftIcon.text : nftIcon.kind, 'EX')
	})

	test('uses the same token icon in address cards as in token symbols', async () => {
		const tokenSymbolIcon = await renderTokenSymbolIcon(createErc20Entry())
		const smallAddressIcon = await renderFirstIcon(<SmallAddress addressBookEntry = { createErc20Entry() } renameAddressCallBack = { () => undefined } />)
		assert.deepEqual(smallAddressIcon, tokenSymbolIcon)
	})

	test('keeps the Blockie for contacts in address cards', async () => {
		const contactEntry: AddressBookEntry = { type: 'contact', name: 'Friend', address: USDC_ADDRESS, entrySource: 'User' }
		assert.deepEqual(await renderFirstIcon(<SmallAddress addressBookEntry = { contactEntry } renameAddressCallBack = { () => undefined } />), { kind: 'blockie' })
	})
})

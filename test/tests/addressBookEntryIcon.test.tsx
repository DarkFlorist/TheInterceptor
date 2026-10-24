import * as assert from 'assert'
import { render } from 'preact'
import type { JSX } from 'preact/jsx-runtime'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { TokenSymbol } from '../../app/ts/components/subcomponents/coins.js'
import { SmallAddress } from '../../app/ts/components/subcomponents/address.js'
import type { Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
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
	| { readonly kind: 'curatedTicker', readonly text: string | undefined, readonly backgroundColor: string | undefined, readonly className: string | undefined }
	| { readonly kind: 'blockieWithTicker', readonly text: string | undefined, readonly blockiePixels: string }
	| { readonly kind: 'blockie', readonly blockiePixels: string }
	| { readonly kind: 'logo', readonly src: string | undefined }

const USDC_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const SAME_SYMBOL_TOKEN_ADDRESS = 0x1111111111111111111111111111111111111111n

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

const findSpanWithClass = (container: RenderTreeNode, className: string) => collectElements(container, 'span').find((element) => element.getAttribute?.('class')?.split(' ').includes(className) === true)

// The fill of every Blockie pixel in order, which is the address fingerprint the Blockie shows
const readBlockiePixels = (container: RenderTreeNode) => collectElements(container, 'rect').map((pixel) => pixel.getAttribute?.('fill') ?? '').join(' ')

function readFirstIcon(container: RenderTreeNode): RenderedIcon {
	const iconSlot = collectElements(container, 'span').find((element) => element.getAttribute?.('role') === 'img')
	if (iconSlot === undefined) throw new Error('Expected an icon slot')
	const [image] = collectElements(iconSlot, 'img')
	if (image !== undefined) return { kind: 'logo', src: image.getAttribute?.('src') ?? undefined }
	const curatedTickerIcon = findSpanWithClass(iconSlot, 'token-ticker-icon')
	if (curatedTickerIcon !== undefined) {
		return {
			kind: 'curatedTicker',
			text: curatedTickerIcon.getAttribute?.('data-ticker-text') ?? undefined,
			backgroundColor: curatedTickerIcon.style?.['backgroundColor'],
			className: curatedTickerIcon.getAttribute?.('class') ?? undefined,
		}
	}
	const blockieWithTicker = findSpanWithClass(iconSlot, 'blockie-with-ticker')
	if (blockieWithTicker !== undefined) return { kind: 'blockieWithTicker', text: blockieWithTicker.getAttribute?.('data-ticker-text') ?? undefined, blockiePixels: readBlockiePixels(blockieWithTicker) }
	const blockiePixels = readBlockiePixels(iconSlot)
	if (blockiePixels !== '') return { kind: 'blockie', blockiePixels }
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

// Which entry gets which icon kind is tested in addressBookEntryIconChoice.test.ts, these tests check how each kind is rendered
describe('address book entry icons', () => {
	test('renders the logo of an entry that has one', async () => {
		assert.deepEqual(await renderTokenSymbolIcon(createErc20Entry({ logoUri: 'https://logo.example/usdc.png' })), { kind: 'logo', src: 'https://logo.example/usdc.png' })
	})

	test('renders a curated ticker as an address-colored circle with a size class for single characters', async () => {
		const icon = await renderTokenSymbolIcon(createErc20Entry())
		const singleCharacterIcon = await renderTokenSymbolIcon(createErc20Entry({ symbol: 'u' }))
		if (icon.kind !== 'curatedTicker' || singleCharacterIcon.kind !== 'curatedTicker') throw new Error('Expected curated ticker icons')
		assert.equal(icon.text, 'US')
		assert.equal(icon.className, 'token-ticker-icon')
		assert.match(icon.backgroundColor ?? '', /^hsl\(\d+, 60%, 75%\)$/u)
		assert.equal(singleCharacterIcon.text, 'U')
		assert.equal(singleCharacterIcon.className, 'token-ticker-icon token-ticker-icon--single-character')
	})

	test('gives curated tokens with the same symbol different ticker colors when their addresses differ', async () => {
		const usdcIcon = await renderTokenSymbolIcon(createErc20Entry())
		const sameSymbolIcon = await renderTokenSymbolIcon(createErc20Entry({ address: SAME_SYMBOL_TOKEN_ADDRESS, entrySource: 'Interceptor' }))
		const usdcIconAgain = await renderTokenSymbolIcon(createErc20Entry())
		if (usdcIcon.kind !== 'curatedTicker' || sameSymbolIcon.kind !== 'curatedTicker' || usdcIconAgain.kind !== 'curatedTicker') throw new Error('Expected curated ticker icons')
		assert.equal(usdcIcon.text, sameSymbolIcon.text)
		assert.notEqual(usdcIcon.backgroundColor, sameSymbolIcon.backgroundColor)
		assert.equal(usdcIcon.backgroundColor, usdcIconAgain.backgroundColor)
	})

	test('draws a user token ticker over the same plain Blockie that an on-chain token at that address gets', async () => {
		const userTokenIcon = await renderTokenSymbolIcon(createErc20Entry({ address: SAME_SYMBOL_TOKEN_ADDRESS, entrySource: 'User' }))
		const plainBlockieIcon = await renderTokenSymbolIcon(createErc20Entry({ address: SAME_SYMBOL_TOKEN_ADDRESS, entrySource: 'OnChain' }))
		if (userTokenIcon.kind !== 'blockieWithTicker' || plainBlockieIcon.kind !== 'blockie') throw new Error('Expected a Blockie with a ticker and a plain Blockie')
		assert.equal(userTokenIcon.text, 'US')
		assert.equal(userTokenIcon.blockiePixels, plainBlockieIcon.blockiePixels)
	})

	test('gives user tokens with the same symbol different Blockies when their addresses differ', async () => {
		const userUsdcIcon = await renderTokenSymbolIcon(createErc20Entry({ entrySource: 'User' }))
		const sameSymbolIcon = await renderTokenSymbolIcon(createErc20Entry({ address: SAME_SYMBOL_TOKEN_ADDRESS, entrySource: 'User' }))
		if (userUsdcIcon.kind !== 'blockieWithTicker' || sameSymbolIcon.kind !== 'blockieWithTicker') throw new Error('Expected Blockies with a ticker')
		assert.equal(userUsdcIcon.text, sameSymbolIcon.text)
		assert.notEqual(userUsdcIcon.blockiePixels, sameSymbolIcon.blockiePixels)
	})

	test('keeps ticker letters out of the rendered text so copied labels stay unchanged', async () => {
		for (const entrySource of ['DarkFloristMetadata', 'User'] as const) {
			const iconSlotTexts = await renderIntoDom(createTokenSymbol(createErc20Entry({ entrySource })), (container) => collectElements(container, 'span').filter((element) => element.getAttribute?.('role') === 'img').map((element) => element.textContent))
			assert.ok(iconSlotTexts.length > 0, entrySource)
			assert.deepEqual(iconSlotTexts.filter((text) => text !== ''), [], entrySource)
		}
	})

	test('draws the curated ticker letters from the data attribute inside a 1em circle', async () => {
		const css = await readInterceptorAppCss()
		const iconRule = css.match(/\.token-ticker-icon \{([\s\S]*?)\n\}/u)?.[1] ?? ''
		assert.match(iconRule, /border-radius: 50%;/u)
		assert.match(iconRule, /width: 1em;/u)
		assert.match(iconRule, /height: 1em;/u)
		assert.match(iconRule, /color: var\(--black-color\);/u)
		assert.match(css, /\.token-ticker-icon::before \{[^}]*content: attr\(data-ticker-text\);/u)
	})

	test('draws the user token ticker letters from the data attribute on a dark pill inside the 1em Blockie', async () => {
		const css = await readInterceptorAppCss()
		const overlayRule = css.match(/\.blockie-with-ticker \{([\s\S]*?)\n\}/u)?.[1] ?? ''
		assert.match(overlayRule, /width: 1em;/u)
		assert.match(overlayRule, /height: 1em;/u)
		assert.match(overlayRule, /overflow: hidden;/u)
		const tickerRule = css.match(/\.blockie-with-ticker::after \{([\s\S]*?)\n\}/u)?.[1] ?? ''
		assert.match(tickerRule, /content: attr\(data-ticker-text\);/u)
		assert.match(tickerRule, /background-color: var\(--black-alpha-d6\);/u)
		assert.match(tickerRule, /color: var\(--text-color\);/u)
		assert.match(css, /\.blockie-with-ticker:is\(\[data-ticker-text\*="M"\], \[data-ticker-text\*="W"\]\)::after \{[^}]*font-size: 0\.34em;/u)
	})

	test('styles only the Copy and Edit chips as chips, never a Blockie with a ticker in the icon slot', async () => {
		// The chip rules in interceptor-pages.css match the inline-card-action-chip class, so the svg and span of this icon cannot make it look like a chip
		const rendered = await renderIntoDom(createTokenSymbol(createErc20Entry({ entrySource: 'User' })), (container) => ({
			icon: readFirstIcon(container),
			chipTitles: collectElements(container, 'span').filter((element) => element.getAttribute?.('class') === 'inline-card-action-chip').map((element) => element.getAttribute?.('title')),
		}))
		assert.equal(rendered.icon.kind, 'blockieWithTicker')
		assert.deepEqual(rendered.chipTitles, ['Copy', 'Edit'])
	})

	test('uses the same token icon in address cards as in token symbols', async () => {
		for (const entrySource of ['DarkFloristMetadata', 'User', 'OnChain'] as const) {
			const tokenSymbolIcon = await renderTokenSymbolIcon(createErc20Entry({ entrySource }))
			const smallAddressIcon = await renderFirstIcon(<SmallAddress addressBookEntry = { createErc20Entry({ entrySource }) } renameAddressCallBack = { () => undefined } />)
			assert.deepEqual(smallAddressIcon, tokenSymbolIcon, entrySource)
		}
	})
})

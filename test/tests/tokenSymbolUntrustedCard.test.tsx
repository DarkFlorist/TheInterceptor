import * as assert from 'assert'
import { render } from 'preact'
import type { JSX } from 'preact/jsx-runtime'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { ON_CHAIN_TOKEN_METADATA_WARNING } from '../../app/ts/components/subcomponents/onChainTokenWarnings.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { TokenSymbol, TokenWithAmount } from '../../app/ts/components/subcomponents/coins.js'
import type { Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import { installDomMock } from './domMock.js'

type RenderTreeNode = {
	readonly childNodes?: readonly RenderTreeNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly style?: Record<string, string>
}

const collectElements = (node: RenderTreeNode, matches: (element: RenderTreeNode) => boolean): readonly RenderTreeNode[] => [
	...(matches(node) ? [node] : []),
	...(node.childNodes ?? []).flatMap((child) => collectElements(child, matches)),
]

const collectCards = (container: RenderTreeNode) => collectElements(container, (element) => element.getAttribute?.('class') === 'inline-card')
const collectTokenNames = (container: RenderTreeNode) => collectElements(container, (element) => element.tagName === 'DATA')
const collectWarningSigns = (container: RenderTreeNode) => collectElements(container, (element) => element.getAttribute?.('class') === 'inline-card-warning-sign')

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

const createToken = (entrySource: Erc20TokenEntry['entrySource']): Erc20TokenEntry => ({
	type: 'ERC20',
	name: 'Asteroid Shiba',
	symbol: 'ASTEROID',
	decimals: 18n,
	address: 0xf280b16ef293d8e534e370794ef26bf312694126n,
	entrySource,
})

const createTokenSymbol = (entrySource: Erc20TokenEntry['entrySource'], style: JSX.CSSProperties) => <TokenSymbol tokenEntry = { createToken(entrySource) } style = { style } renameAddressCallBack = { () => undefined } fontSize = 'normal' />

// The colors callers pick for rows on the page background, all of them hard to read on the red untrusted card
const ROW_COLORS = ['var(--danger-color)', 'var(--danger-dim-color)', 'var(--dim-text-color)', 'var(--disabled-text-color)']

describe('untrusted token card', () => {
	test('lets the card stylesheet color warning labels whatever color the row uses', async () => {
		for (const color of ROW_COLORS) {
			const nameColors = await renderIntoDom(createTokenSymbol('OnChain', { color }), (container) => collectTokenNames(container).map((name) => name.style?.['color'] ?? ''))
			assert.ok(nameColors.length > 0)
			assert.deepEqual([...new Set(nameColors)], [''])
		}
	})

	test('sets no inline style on the labels of normal, expanded and noninteractive cards, so the stylesheet decides their color and weight', async () => {
		for (const nonInteractive of [false, true]) {
			const labelStyles = await renderIntoDom(<InlineCard icon = { () => <span /> } label = 'Warning' warningMessage = 'Untrusted' nonInteractive = { nonInteractive } style = { { color: 'red', 'font-weight': '500' } } />, (container) => collectTokenNames(container).map((name) => name.style?.['color'] ?? name.style?.['font-weight']))
			assert.ok(labelStyles.length >= 2)
			assert.ok(labelStyles.every((style) => style === undefined))
		}
	})

	// The DOM mock applies no stylesheet, so the inheritance the labels rely on is checked in the stylesheet itself: the global data rule resets font-weight on the element, which the card rule has to undo.
	test('makes card labels inherit the card color and weight, and keeps warning card labels readable', async () => {
		const css = await Bun.file('app/css/interceptor-pages.css').text()
		const labelRule = /\n\tdata \{([^}]*)\}/.exec(css.slice(css.indexOf('\n.inline-card {')))?.[1] ?? ''
		assert.match(labelRule, /color: inherit;/)
		assert.match(labelRule, /font-weight: inherit;/)
		assert.match(css, /&:has\(\.inline-card-warning-sign\) \{[^}]*data \{ color: var\(--text-color\); \}/)
	})

	test('keeps both warning signs that turn the card red', async () => {
		const warningTitles = await renderIntoDom(createTokenSymbol('OnChain', { color: 'var(--danger-dim-color)' }), (container) => collectWarningSigns(container).map((sign) => sign.getAttribute?.('data-warning-tooltip')))
		assert.deepEqual(warningTitles, [ON_CHAIN_TOKEN_METADATA_WARNING, ON_CHAIN_TOKEN_METADATA_WARNING])
	})

	test('keeps the other styles of the row', async () => {
		const nameWeights = await renderIntoDom(createTokenSymbol('OnChain', { color: 'var(--danger-color)', 'font-weight': '500' }), (container) => collectCards(container).map((card) => card.style?.['font-weight']))
		assert.deepEqual([...new Set(nameWeights)], ['500'])
	})

	test('leaves the amount next to the card in the row color', async () => {
		const amountColors = await renderIntoDom(
			<TokenWithAmount tokenEntry = { createToken('OnChain') } amount = { -5n } showSign = { true } style = { { color: 'var(--danger-dim-color)' } } renameAddressCallBack = { () => undefined } fontSize = 'normal' />,
			(container) => collectElements(container, (element) => element.tagName === 'P').map((amount) => amount.style?.['color']),
		)
		assert.deepEqual(amountColors, ['var(--danger-dim-color)'])
	})

	test('leaves a token without a warning in the row color', async () => {
		const { nameColors, warningSigns } = await renderIntoDom(createTokenSymbol('DarkFloristMetadata', { color: 'var(--danger-dim-color)' }), (container) => ({
			nameColors: collectCards(container).map((card) => card.style?.['color']),
			warningSigns: collectWarningSigns(container),
		}))
		assert.equal(warningSigns.length, 0)
		assert.deepEqual([...new Set(nameColors)], ['var(--danger-dim-color)'])
	})
})

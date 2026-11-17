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
			const nameColors = await renderIntoDom(createTokenSymbol('OnChain', { color }), (container) => collectTokenNames(container).map((name) => name.style?.['color']))
			assert.ok(nameColors.length > 0)
			assert.deepEqual([...new Set(nameColors)], [''])
		}
	})

	test('protects every warning card label, including expanded and noninteractive labels', async () => {
		for (const nonInteractive of [false, true]) {
			const colors = await renderIntoDom(<InlineCard icon = { () => <span /> } label = 'Warning' warningMessage = 'Untrusted' nonInteractive = { nonInteractive } style = { { color: 'red', 'font-weight': '500' } } />, (container) => collectTokenNames(container).map((name) => ({ color: name.style?.['color'], weight: name.style?.['font-weight'] })))
			assert.ok(colors.length >= 2)
			assert.ok(colors.every(({ color, weight }) => color === '' && weight === '500'))
		}
	})

	test('keeps both warning signs that turn the card red', async () => {
		const warningTitles = await renderIntoDom(createTokenSymbol('OnChain', { color: 'var(--danger-dim-color)' }), (container) => collectWarningSigns(container).map((sign) => sign.getAttribute?.('data-warning-tooltip')))
		assert.deepEqual(warningTitles, [ON_CHAIN_TOKEN_METADATA_WARNING, ON_CHAIN_TOKEN_METADATA_WARNING])
	})

	test('keeps the other styles of the row', async () => {
		const nameWeights = await renderIntoDom(createTokenSymbol('OnChain', { color: 'var(--danger-color)', 'font-weight': '500' }), (container) => collectTokenNames(container).map((name) => name.style?.['font-weight']))
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
			nameColors: collectTokenNames(container).map((name) => name.style?.['color']),
			warningSigns: collectWarningSigns(container),
		}))
		assert.equal(warningSigns.length, 0)
		assert.deepEqual([...new Set(nameColors)], ['var(--danger-dim-color)'])
	})
})

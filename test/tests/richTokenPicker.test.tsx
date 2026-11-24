import * as assert from 'node:assert'
import { test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useRichTokenPicker } from '../../app/ts/components/hooks/useRichTokenPicker.js'
import type { RichTokenOption } from '../../app/ts/types/richMode.js'
import { getRichTokenIdentityKey } from '../../app/ts/utils/richTokens.js'
import { installDomMock } from './domMock.js'

const option = (tokenAddress: bigint, symbol: string, tokenType: 'ERC20' | 'ERC1155', tokenId?: bigint): RichTokenOption => ({
	chainId: 1n, tokenAddress, tokenType, tokenId, name: `${ symbol } token`, symbol, decimals: 0n, amount: 1n, balanceSlot: undefined, erc1155StorageOrder: undefined, enabled: false,
})
const usdc = option(1n, 'USDC', 'ERC20')
const dai = option(2n, 'DAI', 'ERC20')
const item = option(3n, 'ITEM', 'ERC1155', 7n)

const keyDown = (key: string) => {
	let prevented = false
	return { event: { key, preventDefault: () => { prevented = true } }, wasPrevented: () => prevented }
}

test('the token picker hook filters, searches, highlights, selects and remembers tokens on its own', async () => {
	const dom = installDomMock()
	const availableTokens = signal<readonly RichTokenOption[]>([usdc, dai, item])
	let picker: ReturnType<typeof useRichTokenPicker> | undefined
	function Harness() {
		picker = useRichTokenPicker({ availableTokens })
		return undefined
	}
	const symbols = () => picker?.data.value.matchingAvailableRichTokens.map((token) => token.symbol)
	try {
		await act(() => { render(h(Harness, {}), dom.document.body) })
		if (picker === undefined) throw new Error('Expected the picker hook')
		assert.deepEqual(symbols(), ['USDC', 'DAI', 'ITEM'])

		await act(() => { picker?.actions.selectFilter('ERC1155') })
		assert.deepEqual(symbols(), ['ITEM'])
		await act(() => { picker?.actions.selectFilter('All'); picker?.actions.setSearch('da') })
		assert.deepEqual(symbols(), ['DAI'])
		await act(() => { picker?.actions.setSearch('') })

		// The highlight wraps in both directions, and Enter toggles the highlighted token.
		const down = keyDown('ArrowDown')
		await act(() => { picker?.actions.handleSearchKeyDown(down.event) })
		assert.equal(down.wasPrevented(), true)
		assert.equal(picker.data.value.activeRichTokenIndex, 1)
		await act(() => { picker?.actions.handleSearchKeyDown(keyDown('ArrowUp').event); picker?.actions.handleSearchKeyDown(keyDown('ArrowUp').event) })
		assert.equal(picker.data.value.activeRichTokenIndex, 2)
		await act(() => { picker?.actions.handleSearchKeyDown(keyDown('Enter').event) })
		assert.deepEqual(picker.data.value.selectedRichTokenKeys, [getRichTokenIdentityKey(item)])
		assert.deepEqual(picker.data.value.selectedAvailableRichTokens.map((token) => token.symbol), ['ITEM'])

		// Without a query, selected tokens come first, then recently added ones.
		await act(() => { picker?.actions.rememberRecent(getRichTokenIdentityKey(dai)) })
		assert.deepEqual(symbols(), ['ITEM', 'DAI', 'USDC'])

		// A reset clears the dialog view but keeps the recently added tokens.
		await act(() => { picker?.actions.scrollResults(40); picker?.actions.reset() })
		assert.deepEqual(picker.data.value.selectedRichTokenKeys, [])
		assert.equal(picker.data.value.richTokenResultsScrollTop, 0)
		assert.equal(picker.data.value.activeRichTokenIndex, 0)
		assert.deepEqual(picker.data.value.recentRichTokenKeys, [getRichTokenIdentityKey(dai)])
		assert.deepEqual(symbols(), ['DAI', 'USDC', 'ITEM'])

		await act(() => { picker?.actions.toggleSelection(usdc); picker?.actions.toggleSelection(dai); picker?.actions.deselect([getRichTokenIdentityKey(usdc)]) })
		assert.deepEqual(picker.data.value.selectedRichTokenKeys, [getRichTokenIdentityKey(dai)])
		await act(() => { availableTokens.value = [usdc, item] })
		assert.deepEqual(picker.data.value.selectedAvailableRichTokens, [], 'a selected token that is no longer available is not offered')
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})

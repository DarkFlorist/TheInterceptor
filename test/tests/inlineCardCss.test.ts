import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readInterceptorAppCss } from './cssTestUtils.js'

describe('inline card action layout CSS', () => {
	test('keeps hover action labels on one line inside wrapping containers', async () => {
		const css = await readInterceptorAppCss()
		const actionMatch = css.match(/> :not\(\[role=img\]\):has\(svg\):has\(span\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(actionMatch)
		assert.match(actionMatch[1], /white-space: nowrap;/)
	})

	test('never styles the repeated entry icon slot as a copy or edit chip', async () => {
		// A Blockie with a ticker holds an svg and a span like the chips do, and the chip rules would hide its Blockie on hover
		const css = await readInterceptorAppCss()
		const chipSelectors = css.match(/^\s*>[^{\n]*:has\(svg\):has\(span\)[^{\n]*\{/gmu) ?? []
		assert.ok(chipSelectors.length > 0)
		for (const chipSelector of chipSelectors) assert.match(chipSelector, /:not\(\[role=img\]\)/u, chipSelector.trim())
	})

	test('keeps selectable identity, copy, and edit controls on one row', async () => {
		const css = await readInterceptorAppCss()
		const selectableActions = css.match(/&:has\(> \.inline-card-expanded-label\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(selectableActions)
		assert.match(selectableActions[1], /grid-template-columns: minmax\(0, 1fr\) max-content max-content;/)
	})
})

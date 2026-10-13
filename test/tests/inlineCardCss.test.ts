import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { matchCssBlock, readInterceptorAppCss } from './cssTestUtils.js'

describe('inline card action layout CSS', () => {
	test('keeps hover action labels on one line inside wrapping containers', async () => {
		const css = await readInterceptorAppCss()
		const actionCss = matchCssBlock(css, /> :has\(svg\):has\(span\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.match(actionCss, /white-space: nowrap;/)
	})

	test('keeps selectable identity, copy, and edit controls on one row', async () => {
		const css = await readInterceptorAppCss()
		const selectableActionsCss = matchCssBlock(css, /&:has\(> \.inline-card-expanded-label\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.match(selectableActionsCss, /grid-template-columns: minmax\(0, 1fr\) max-content max-content;/)
	})
})

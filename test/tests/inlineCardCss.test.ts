import * as assert from 'assert'
import { describe, test } from 'bun:test'

describe('inline card action layout CSS', () => {
	test('keeps hover action labels on one line inside wrapping containers', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const actionMatch = css.match(/> :has\(svg\):has\(span\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(actionMatch)
		assert.match(actionMatch[1], /white-space: nowrap;/)
	})

	test('keeps selectable identity, copy, and edit controls on one row', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const selectableActions = css.match(/&:has\(> \.inline-card-expanded-label\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(selectableActions)
		assert.match(selectableActions[1], /grid-template-columns: minmax\(0, 1fr\) max-content max-content;/)
	})
})

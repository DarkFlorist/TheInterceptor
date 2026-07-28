import * as assert from 'assert'
import { describe, test } from 'bun:test'

describe('inline card action layout CSS', () => {
	test('keeps hover action labels on one line inside wrapping containers', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const actionMatch = css.match(/> :has\(svg\):has\(span\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(actionMatch)
		assert.match(actionMatch[1], /white-space: nowrap;/)
	})
})

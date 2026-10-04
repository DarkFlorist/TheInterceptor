import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readInterceptorAppCss } from './cssTestUtils.js'

describe('delegation flow layout CSS', () => {
	async function getDelegationFlowCss() {
		const css = await readInterceptorAppCss()
		const rowMatch = css.match(/\.delegation-flow-row\s*\{([\s\S]*?)\n\}/)
		const connectorMatch = css.match(/\.delegation-flow-connector\s*\{([\s\S]*?)\n\}/)
		const targetsMatch = css.match(/\.delegation-flow-targets\s*\{([\s\S]*?)\n\}/)
		const buttonMatch = css.match(/\.delegation-flow-address-button\s*\{([\s\S]*?)\n\}/)
		assert.ok(rowMatch)
		assert.ok(connectorMatch)
		assert.ok(targetsMatch)
		assert.ok(buttonMatch)
		return {
			rowCss: rowMatch[1],
			connectorCss: connectorMatch[1],
			targetsCss: targetsMatch[1],
			buttonCss: buttonMatch[1],
		}
	}

	test('uses content-driven wrapping instead of a viewport breakpoint', async () => {
		const { rowCss, connectorCss, targetsCss, buttonCss } = await getDelegationFlowCss()
		assert.match(rowCss, /display: flex;/)
		assert.match(rowCss, /flex-wrap: wrap;/)
		assert.match(rowCss, /width: 100%;/)
		assert.match(connectorCss, /display: inline-flex;/)
		assert.match(connectorCss, /flex: 0 0 auto;/)
		assert.match(targetsCss, /display: inline-flex;/)
		assert.match(targetsCss, /flex-wrap: wrap;/)
		assert.match(buttonCss, /flex: 0 1 auto;/)
		assert.match(buttonCss, /min-width: 0;/)
	})
})

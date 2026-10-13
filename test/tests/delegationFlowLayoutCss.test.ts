import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { matchCssBlock, readInterceptorAppCss } from './cssTestUtils.js'

describe('delegation flow layout CSS', () => {
	async function getDelegationFlowCss() {
		const css = await readInterceptorAppCss()
		return {
			rowCss: matchCssBlock(css, /\.delegation-flow-row\s*\{([\s\S]*?)\n\}/),
			connectorCss: matchCssBlock(css, /\.delegation-flow-connector\s*\{([\s\S]*?)\n\}/),
			targetsCss: matchCssBlock(css, /\.delegation-flow-targets\s*\{([\s\S]*?)\n\}/),
			buttonCss: matchCssBlock(css, /\.delegation-flow-address-button\s*\{([\s\S]*?)\n\}/),
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

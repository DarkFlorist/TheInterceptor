import * as assert from 'assert'
import { describe, test } from 'bun:test'

describe('delegation flow layout CSS', () => {
	async function getDelegationFlowMobileCss() {
		const css = await Bun.file('app/css/interceptor.css').text()
		const start = css.indexOf('@media screen and (max-width: 480px) {')
		assert.notEqual(start, -1)
		const end = css.indexOf('\n}\n\n.swap-box', start)
		assert.notEqual(end, -1)
		return { css, mobileCss: css.slice(start, end) }
	}

	test('keeps the delegated execution row horizontal at extension popup width', async () => {
		const { css } = await getDelegationFlowMobileCss()
		const delegationFlowRowMediaQueries = Array.from(css.matchAll(
			/@media screen and \(max-width: ([0-9]+)px\) \{[\s\S]*?\.delegation-flow-row[\s\S]*?\n\}/g,
		))
		assert.ok(delegationFlowRowMediaQueries.length > 0)
		for (const mediaQuery of delegationFlowRowMediaQueries) {
			const breakpoint = Number(mediaQuery[1])
			assert.ok(breakpoint < 600, `delegation flow should remain horizontal at popup width, found ${ breakpoint }px breakpoint`)
		}
	})

	test('allows the delegated execution row to shrink in the narrow layout', async () => {
		const { mobileCss } = await getDelegationFlowMobileCss()
		assert.match(mobileCss, /\.delegation-flow-row\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/)
		assert.match(mobileCss, /\.delegation-flow-row\s*\{[\s\S]*width: 100%;/)
		assert.match(mobileCss, /\.delegation-flow-address-button,\n\t\.delegation-flow-address\s*\{[\s\S]*width: 100%;/)
		assert.match(mobileCss, /\.delegation-flow-address-primary\s*\{[\s\S]*white-space: normal;/)
		assert.match(mobileCss, /\.delegation-flow-address-primary\s*\{[\s\S]*overflow-wrap: anywhere;/)
	})
})

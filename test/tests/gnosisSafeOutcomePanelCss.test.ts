import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readInterceptorAppCss } from './cssTestUtils.js'

function expectRule(css: string, selector: string) {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp(`${ escapedSelector }\\s*\\{([\\s\\S]*?)\\}`).exec(css)
	if (match?.[1] === undefined) throw new Error(`Missing CSS rule for ${ selector }`)
	return match[1]
}

describe('Gnosis Safe outcome panel CSS', () => {
	test('uses the primary color for the loading spinner', async () => {
		const css = await readInterceptorAppCss()
		const loadingRules = [...css.matchAll(/\.gnosis-safe-outcome-panel__loading\s*\{([^}]*)\}/g)]
		assert.equal(loadingRules.some((rule) => rule[1]?.includes('color: var(--accent-color);')), true)
	})

	test('constrains nested simulation cards to the available panel width', async () => {
		const css = await readInterceptorAppCss()
		const content = expectRule(css, '.gnosis-safe-outcome-panel__content')
		const result = expectRule(css, '.gnosis-safe-outcome-panel__result')
		const resultCard = expectRule(css, '.gnosis-safe-outcome-panel__result > .card')
		const importanceBox = expectRule(css, '.gnosis-safe-outcome-panel__result .transaction-importance-box')

		assert.match(content, /max-width:\s*100%;/)
		assert.match(content, /min-width:\s*0;/)
		assert.match(result, /grid-template-columns:\s*minmax\(0, 1fr\);/)
		assert.match(result, /max-width:\s*100%;/)
		assert.match(result, /min-width:\s*0;/)
		assert.match(resultCard, /min-width:\s*0;/)
		assert.match(resultCard, /width:\s*100%;/)
		assert.match(importanceBox, /max-width:\s*100%;/)
		assert.match(importanceBox, /width:\s*100%;/)
	})
})

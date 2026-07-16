import * as assert from 'assert'
import { test } from 'bun:test'

test('Safe outcome loading spinner uses the primary color', async () => {
	const css = await Bun.file('app/css/interceptor.css').text()
	const loadingRules = [...css.matchAll(/\.safe-outcome-panel__loading\s*\{([^}]*)\}/g)]
	assert.equal(loadingRules.some((rule) => rule[1]?.includes('color: var(--primary-color);')), true)
})

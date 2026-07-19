import * as assert from 'assert'
import { describe, test } from 'bun:test'

function getRuleBody(css: string, selector: string) {
	const selectorIndex = css.indexOf(selector)
	if (selectorIndex === -1) throw new Error(`Expected CSS selector "${ selector }"`)
	const ruleStart = css.indexOf('{', selectorIndex)
	const ruleEnd = css.indexOf('}', ruleStart)
	if (ruleStart === -1 || ruleEnd === -1) throw new Error(`Expected complete CSS rule for "${ selector }"`)
	return css.slice(ruleStart + 1, ruleEnd)
}

describe('popup loading animation CSS', () => {
	test('releases reveal transforms after animations so dropdowns keep their stacking behavior', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const revealRule = getRuleBody(css, '.popup-data-reveal {')
		const inlineRevealRule = getRuleBody(css, '.popup-data-reveal-inline {')

		assert.match(revealRule, /animation:\s*popup-data-reveal/)
		assert.match(inlineRevealRule, /animation:\s*popup-data-reveal/)
		assert.doesNotMatch(revealRule, /\b(?:both|forwards)\b|animation-fill-mode/)
		assert.doesNotMatch(inlineRevealRule, /\b(?:both|forwards)\b|animation-fill-mode/)
	})
})

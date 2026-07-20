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

describe('popup loading layout and animation CSS', () => {
	test('keeps the shared active address layout more specific than the generic log table', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const activeAddressRule = getRuleBody(css, '.log-table.active-address-row {')

		assert.match(activeAddressRule, /grid-template-columns:\s*auto max-content/)
	})

	test('sizes loading controls from their real content instead of fixed button dimensions', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()
		const loadingControlRule = getRuleBody(css, '.popup-loading-control {')
		const loadingInputRule = getRuleBody(css, '.input.popup-loading-input {')
		const rpcSlotRule = getRuleBody(css, '.popup-home-rpc-selector {')

		assert.match(loadingControlRule, /position:\s*relative/)
		assert.doesNotMatch(loadingControlRule, /\b(?:height|width):/)
		assert.match(loadingInputRule, /-webkit-text-fill-color:\s*transparent/)
		assert.match(loadingInputRule, /color:\s*transparent/)
		assert.match(rpcSlotRule, /width:\s*9rem/)
		assert.doesNotMatch(css, /popup-loading-(?:action-button|rpc-selector|simulation-action|time-picker-(?:mode|value|commit))/)
	})

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

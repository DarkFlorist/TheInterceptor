import * as assert from 'assert'
import { test } from 'bun:test'

test('rich-mode interactions disable transitions for reduced motion', async () => {
	const css = await Bun.file('app/css/interceptor.css').text()
	const reducedMotionRules = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
	for (const selector of ['.rich-mode-account-row', '.rich-mode-amount-with-unit', '.rich-mode-balance-page', '.rich-mode-modal-footer', '.rich-mode-remove-token', '.rich-mode-token-result']) {
		assert.match(reducedMotionRules, new RegExp(`\\${ selector }[,\\s]`, 'u'))
	}
	assert.match(reducedMotionRules, /transition:\s*none;/u)
})

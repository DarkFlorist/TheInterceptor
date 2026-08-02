import * as assert from 'assert'
import { test } from 'bun:test'

test('rich-mode interactions disable transitions for reduced motion', async () => {
	const css = await Bun.file('app/css/interceptor.css').text()
	const reducedMotionRules = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
	for (const selector of ['.rich-mode-account-row', '.rich-mode-amount-with-unit', '.rich-mode-balance-page', '.rich-mode-remove-token', '.rich-mode-reset-amount', '.rich-mode-token-result']) {
		assert.match(reducedMotionRules, new RegExp(`\\${ selector }[,\\s]`, 'u'))
	}
	assert.match(reducedMotionRules, /transition:\s*none;/u)
	assert.match(reducedMotionRules, /\.rich-mode-save-status\.is-saving::before\s*,[\s\S]*\.rich-mode-save-status\.is-saved\s*,[\s\S]*\.rich-mode-balance-row\.is-new\s*\{\s*animation:\s*none;/u)
})

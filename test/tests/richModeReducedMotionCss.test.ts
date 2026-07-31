import * as assert from 'assert'
import { test } from 'bun:test'

test('rich-mode recessed panels disable transitions for reduced motion', async () => {
	const css = await Bun.file('app/css/interceptor.css').text()
	assert.match(
		css,
		/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.rich-mode-balance-page,\s*\.rich-mode-modal-footer\s*\{\s*transition:\s*none;/u,
	)
})

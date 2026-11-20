import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readInterceptorAppCss } from './cssTestUtils.js'

async function readInlineCardCss() {
	const inlineCardBlock = (await readInterceptorAppCss()).match(/\n\.inline-card \{[\s\S]*?\n\}\n/)
	if (inlineCardBlock === null) throw new Error('Expected the .inline-card stylesheet block')
	return inlineCardBlock[0]
}

describe('inline card action layout CSS', () => {
	test('keeps hover action labels on one line inside wrapping containers', async () => {
		const css = await readInterceptorAppCss()
		const actionMatch = css.match(/> \.inline-card-action-chip\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(actionMatch)
		assert.match(actionMatch[1], /white-space: nowrap;/)
	})

	test('keeps selectable identity, copy, and edit controls on one row', async () => {
		const css = await readInterceptorAppCss()
		const selectableActions = css.match(/&:has\(> \.inline-card-expanded-label\)\s*\{([\s\S]*?)\n\s*\}/)
		assert.ok(selectableActions)
		assert.match(selectableActions[1], /grid-template-columns: minmax\(0, 1fr\) max-content max-content;/)
	})

	// Only the leading warning sign is an alert and the trailing one is aria-hidden without a role, so a [role=alert] selector would leave the trailing sign unstyled.
	test('styles both warning signs through their shared class rather than the alert role only the leading sign carries', async () => {
		const inlineCardCss = await readInlineCardCss()
		assert.doesNotMatch(inlineCardCss, /\[role=alert\]/)
		assert.match(inlineCardCss, /&:has\(\.inline-card-warning-sign\) \{\s*--bg-status-color: var\(--status-dimmed-bg-color\);/)
		assert.match(inlineCardCss, /\n\t\.inline-card-warning-sign \{[^}]*cursor: help;/)
	})

	// The card renders its Tooltip and its shown hint beside the signs, so sibling selectors would tie the signs' spacing to where those render.
	test('spaces the warning signs without depending on the elements around them', async () => {
		const inlineCardCss = await readInlineCardCss()
		const warningSignRule = inlineCardCss.match(/\n\t\.inline-card-warning-sign \{(.*?)\n\t\}/su)
		assert.ok(warningSignRule)
		assert.match(warningSignRule[1], /\n\t\tmargin-right: 0\.25em;/)
		assert.match(warningSignRule[1], /&\[aria-hidden\] \{ margin-left: 0\.25em \}/)
		assert.doesNotMatch(warningSignRule[1], /\+ \*|\* \+/)
	})

	test('reveals the action overlay for focused copy and edit buttons but not for a focused warning sign', async () => {
		const inlineCardCss = await readInlineCardCss()
		assert.doesNotMatch(inlineCardCss, /:focus-within > &/)
		assert.match(inlineCardCss, /:hover > &, &:focus-within \{ opacity: 1 \}/)
		assert.equal((inlineCardCss.match(/^\t\t:hover > & \{ opacity: 0 \}$/gm) ?? []).length, 2)
		assert.match(inlineCardCss, /&:has\(> \.inline-card-actions:focus-within\) > :is\(\[role=img\], data\) \{ opacity: 0 \}/)
	})
})

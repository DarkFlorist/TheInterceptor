import * as assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'bun:test'
import { approveBrowserRequest } from '../benchmarks/browserHarness.js'

test('approval checks readiness and clicks before the next popup update can disable the button', async () => {
	let disabled = false
	let clicks = 0
	const button = {
		get disabled() {
			const current = disabled
			// Model a pending popup update arriving after the readiness evaluation returns to the driver.
			queueMicrotask(() => { disabled = true })
			return current
		},
		click: () => { if (!disabled) clicks++ },
	}
	await approveBrowserRequest({ pages: async () => [] }, {
		id: 'approval',
		evaluate: async (expression) => runInNewContext(expression, { document: { querySelector: () => button } }),
	}, 'button')
	assert.equal(disabled, true)
	assert.equal(clicks, 1, 'A separate readiness check followed by a driver click silently loses this approval')
})

test('approval waits through missing and disabled buttons and clicks the newly enabled button once', async () => {
	let evaluations = 0
	let clicks = 0
	const button = { disabled: true, click: () => { clicks++ } }
	await approveBrowserRequest({ pages: async () => [] }, {
		id: 'approval',
		evaluate: async (expression) => {
			evaluations++
			if (evaluations === 3) button.disabled = false
			return runInNewContext(expression, { document: { querySelector: () => evaluations === 1 ? undefined : button } })
		},
	}, 'button')
	assert.ok(evaluations >= 3)
	assert.equal(clicks, 1)
})

test('approval accepts a lost evaluation reply when the popup closed itself', async () => {
	await approveBrowserRequest({ pages: async () => [] }, {
		id: 'approval',
		evaluate: async () => { throw new Error('Execution context was destroyed') },
	}, 'button')
})

test('approval propagates a closed-context error while the popup is still open', async () => {
	const failure = new Error('Execution context was destroyed')
	const page = {
		id: 'approval', url: 'about:blank',
		evaluate: async () => { throw failure },
		navigate: async () => undefined, reload: async () => undefined,
		captureScreenshot: async () => '', close: async () => undefined,
	}
	await assert.rejects(approveBrowserRequest({ pages: async () => [page] }, page, 'button'), failure)
})

test('approval propagates unrelated evaluation failures even after a popup closes', async () => {
	const failure = new Error('Browser transport failed')
	await assert.rejects(approveBrowserRequest({ pages: async () => [] }, {
		id: 'approval',
		evaluate: async () => { throw failure },
	}, 'button'), failure)
})

test('approval does not mistake an application error mentioning closed for a lost popup reply', async () => {
	const failure = new Error('Application channel closed')
	await assert.rejects(approveBrowserRequest({ pages: async () => [] }, { id: 'approval', evaluate: async () => { throw failure } }, 'button'), failure)
})

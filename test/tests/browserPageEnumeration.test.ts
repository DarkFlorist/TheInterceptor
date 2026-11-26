import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { connectStillOpenChromePages } from '../benchmarks/chromeHarness.js'

test('page enumeration retains the approval page when another popup closes before CDP attachment', async () => {
	const targets = [{ id: 'closing-popup' }, { id: 'approval' }]
	const freshLookups: string[] = []
	const pages = await connectStillOpenChromePages(targets, async (target) => {
		if (target.id === 'closing-popup') throw new Error('Failed to open CDP websocket ws://127.0.0.1/devtools/page/closing-popup')
		return target
	}, async (id) => { freshLookups.push(id); return id === 'approval' })
	assert.deepEqual(pages, [{ id: 'approval' }])
	assert.deepEqual(freshLookups, ['closing-popup'])
})

test('a failed debugger attachment remains an error when the target is still open', async () => {
	const failure = new Error('Failed to open CDP websocket ws://127.0.0.1/devtools/page/approval')
	await assert.rejects(connectStillOpenChromePages([{ id: 'approval' }], async () => { throw failure }, async () => true), failure)
})

test('missing-target lookup races are skipped only after a fresh lookup confirms closure', async () => {
	for (const message of ['Target not found: target closing-popup', 'Timed out waiting for target closing-popup after 15000ms']) {
		const pages = await connectStillOpenChromePages([{ id: 'closing-popup' }], async () => { throw new Error(message) }, async () => false)
		assert.deepEqual(pages, [])
	}
})

test('unrelated failures are propagated even if the target subsequently closes', async () => {
	const failure = new Error('Chrome document interception failed')
	let lookedUp = false
	await assert.rejects(connectStillOpenChromePages([{ id: 'closing-popup' }], async () => { throw failure }, async () => { lookedUp = true; return false }), failure)
	assert.equal(lookedUp, false)
})

test('a failed target-state refresh is propagated instead of assuming the popup closed', async () => {
	const failure = new Error('Chrome target list unavailable')
	await assert.rejects(connectStillOpenChromePages([{ id: 'closing-popup' }], async () => { throw new Error('Failed to open CDP websocket ws://127.0.0.1/devtools/page/closing-popup') }, async () => { throw failure }), failure)
})

import * as assert from 'assert'
import { test } from 'bun:test'
import { createSignerSelectionGate } from '../../app/inpage/ts/signerSelectionGate.js'

test('a selection lease distinguishes external blockers from selection call nesting', async () => {
	let idleNotifications = 0
	const gate = createSignerSelectionGate(() => { idleNotifications++ })
	await gate.runSelection(async () => {
		assert.equal(gate.isIdle(), false)
		await gate.runSelection(async () => { assert.equal(gate.hasExternalBlockers(), false) })
		const release = gate.block()
		assert.equal(gate.hasExternalBlockers(), true)
		release()
		assert.equal(gate.hasExternalBlockers(), false)
		assert.equal(idleNotifications, 0)
	})
	assert.equal(gate.isIdle(), true)
	assert.equal(idleNotifications, 1)
})

test('work admitted while a selection awaits its lease remains a blocker until released', async () => {
	const gate = createSignerSelectionGate(() => undefined)
	let resumeLease = () => undefined
	const lease = new Promise<void>((resolve) => { resumeLease = () => resolve() })
	const selecting = gate.runSelection(async () => {
		await lease
		assert.equal(gate.hasExternalBlockers(), true)
	})
	const release = gate.block()
	resumeLease()
	await selecting
	assert.equal(gate.isIdle(), false)
	release()
	assert.equal(gate.isIdle(), true)
	await assert.rejects(gate.runBlocked(async () => { throw new Error('Wallet disconnected') }), /Wallet disconnected/)
	assert.equal(gate.isIdle(), true)
})

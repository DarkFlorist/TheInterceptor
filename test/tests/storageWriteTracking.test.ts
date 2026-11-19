import * as assert from 'node:assert'
import { test } from 'bun:test'
import { createStorageWriteTracking } from '../../app/ts/utils/storageWriteTracking.js'

function createGate() {
	let release: () => void = () => undefined
	const promise = new Promise<void>((resolve) => { release = resolve })
	return { promise, release }
}

test('a snapshot captured during a matching write stays invalid after it settles', async () => {
	const owner = createStorageWriteTracking()
	const gate = createGate()
	const writing = owner.write({ enabled: true }, async () => await gate.promise)
	const snapshot = owner.capture('enabled', true)
	assert.equal(snapshot.isCurrent(), false)
	assert.equal(await snapshot.waitForPendingWrites(0), false)
	gate.release()
	await writing
	assert.equal(snapshot.isCurrent(), false)
	assert.equal(owner.capture('enabled', true).isCurrent(), true)
})

test('other keys and other values do not invalidate or block a snapshot', async () => {
	const owner = createStorageWriteTracking()
	const snapshot = owner.capture('enabled', true)
	const gate = createGate()
	const writing = owner.write({ enabled: false, label: 'Updated' }, async () => await gate.promise)
	try {
		assert.equal(snapshot.isCurrent(), true)
		assert.equal(await snapshot.waitForPendingWrites(0), true)
	} finally {
		gate.release()
		await writing
	}
	assert.equal(snapshot.isCurrent(), true)
})

test('a failed matching write invalidates old snapshots and releases waiters', async () => {
	const owner = createStorageWriteTracking()
	const snapshot = owner.capture('enabled', true)
	const failure = new Error('Storage failed after starting the write')
	await assert.rejects(owner.write({ enabled: true }, async () => { throw failure }), failure)
	assert.equal(snapshot.isCurrent(), false)
	assert.equal(await snapshot.waitForPendingWrites(0), true)
})

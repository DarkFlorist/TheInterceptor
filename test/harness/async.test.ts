import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { flushMicrotasks, settleWithin, waitFor, waitForValue } from './async.js'
import { replaceGlobal } from './globals.js'
import { installManualTimers } from './timers.js'

describe('flushMicrotasks', () => {
	test('runs queued promise callbacks and the callbacks they queue', async () => {
		const steps: string[] = []
		void Promise.resolve()
			.then(() => { steps.push('first') })
			.then(() => { steps.push('second') })
			.then(() => { steps.push('third') })

		await flushMicrotasks()

		assert.deepEqual(steps, ['first', 'second', 'third'])
	})
})

describe('waitFor', () => {
	test('resolves once the condition becomes true', async () => {
		let ready = false
		setTimeout(() => { ready = true }, 10)

		await waitFor(() => ready, { timeoutMs: 1000 })

		assert.equal(ready, true)
	})

	test('rejects with the description after the timeout', async () => {
		await assert.rejects(waitFor(() => false, { timeoutMs: 20, description: 'a message that never arrives' }), /Timed out after 20 ms waiting for a message that never arrives/)
	})

	test('fails immediately when the condition throws', async () => {
		await assert.rejects(waitFor(() => { throw new Error('broken condition') }), /broken condition/)
	})

	test('keeps polling when a test replaces setTimeout', async () => {
		let polls = 0
		const restoreSetTimeout = replaceGlobal('setTimeout', () => { throw new Error('the test replaced setTimeout') })
		try {
			await waitFor(() => {
				polls += 1
				return polls === 3
			})
		} finally {
			restoreSetTimeout()
		}
		assert.equal(polls, 3)
	})
})

describe('waitForValue', () => {
	test('returns the first defined value', async () => {
		const replies: string[] = []
		setTimeout(() => { replies.push('ready') }, 10)

		assert.equal(await waitForValue(() => replies.find((reply) => reply === 'ready')), 'ready')
	})

	test('accepts asynchronous reads', async () => {
		assert.equal(await waitForValue(async () => await Promise.resolve(5)), 5)
	})

	test('times out an asynchronous read that never settles', async () => {
		await assert.rejects(waitForValue(async () => await new Promise<number>(() => undefined), { timeoutMs: 20, description: 'a stuck read' }), /^Error: Timed out after 20 ms waiting for a stuck read$/)
	})

	test('does not accept a value from a synchronous read that runs past the deadline', async () => {
		const readTakingLongerThanTheDeadline = () => {
			// Blocks the thread past the 10 ms deadline, so no timer can fire before the read returns its value.
			Bun.sleepSync(40)
			return 'too late'
		}
		await assert.rejects(waitForValue(readTakingLongerThanTheDeadline, { timeoutMs: 10, description: 'a slow read' }), /^Error: Timed out after 10 ms waiting for a slow read$/)
	})

	test('times out at the deadline instead of reading a value that appears after it', async () => {
		const start = performance.now()
		// The value only appears once the 20 ms deadline has passed and the polling interval is much longer, so a read made after the deadline would return it.
		const readValueAppearingAfterDeadline = () => performance.now() - start >= 20 ? 'too late' : undefined
		await assert.rejects(waitForValue(readValueAppearingAfterDeadline, { timeoutMs: 20, intervalMs: 1000, description: 'a late value' }), /^Error: Timed out after 20 ms waiting for a late value$/)
		assert.ok(performance.now() - start < 1000, 'the wait ended at its deadline instead of after a whole polling interval')
	})
})

describe('settleWithin', () => {
	test('returns the value of a promise that settles in time', async () => {
		assert.equal(await settleWithin(Promise.resolve('settled'), 100, 'never used'), 'settled')
	})

	test('passes on the rejection of a promise that rejects in time', async () => {
		await assert.rejects(settleWithin(Promise.reject(new Error('original failure')), 100, 'never used'), /original failure/)
	})

	test('rejects with the failure message when the promise is still pending after the timeout', async () => {
		await assert.rejects(settleWithin(new Promise<never>(() => undefined), 20, 'the request deadlocked'), /the request deadlocked/)
	})

	test('still times out while a test controls setTimeout', async () => {
		const timers = installManualTimers()
		try {
			await assert.rejects(settleWithin(new Promise<never>(() => undefined), 20, 'the request deadlocked'), /the request deadlocked/)
			assert.equal(timers.pendingCount(), 0)
		} finally {
			timers.restore()
		}
	})
})

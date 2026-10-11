import * as assert from 'assert'
import { test } from 'bun:test'
import { createBackoffRetryScheduler } from '../../app/ts/utils/retryScheduler.js'

function createScheduledRetries() {
	const scheduled: { retry: () => void, timer: ReturnType<typeof setTimeout>, delayMs: number }[] = []
	return {
		scheduled,
		schedule: (retry: () => void, delayMs: number) => {
			const timer = setTimeout(() => undefined, 60_000)
			scheduled.push({ retry, timer, delayMs })
			return timer
		},
		fireNext: () => {
			const next = scheduled.shift()
			assert.ok(next)
			clearTimeout(next.timer)
			next.retry()
			return next.delayMs
		},
		clear: () => { for (const retry of scheduled) clearTimeout(retry.timer) },
	}
}

test('persistent recovery failures back off to five seconds without duplicating pending retries', () => {
	const timers = createScheduledRetries()
	const scheduler = createBackoffRetryScheduler(50, timers.schedule)
	let attempts = 0
	const retry = () => { attempts += 1; scheduler.schedule(retry) }
	try {
		scheduler.schedule(retry)
		const delays: number[] = []
		for (let index = 0; index < 13; index++) {
			scheduler.schedule(retry)
			assert.equal(timers.scheduled.length, 1)
			delays.push(timers.fireNext())
		}
		assert.deepEqual(delays, [50, 100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000, 5000, 5000])
		assert.equal(attempts, 13)
	} finally {
		scheduler.reset()
		timers.clear()
	}
})

test('successful recovery cancels stale callbacks and resets the next failure delay', () => {
	const timers = createScheduledRetries()
	const scheduler = createBackoffRetryScheduler(100, timers.schedule)
	let attempts = 0
	const retry = () => { attempts += 1 }
	try {
		scheduler.schedule(retry)
		assert.equal(timers.fireNext(), 100)
		scheduler.schedule(retry)
		assert.equal(timers.scheduled[0]?.delayMs, 200)
		scheduler.reset()
		scheduler.schedule(retry)
		assert.equal(timers.fireNext(), 200)
		assert.equal(attempts, 1, 'The cancelled callback must not consume the newer retry')
		assert.equal(timers.fireNext(), 100)
		assert.equal(attempts, 2)
	} finally {
		scheduler.reset()
		timers.clear()
	}
})

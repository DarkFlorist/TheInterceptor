import * as assert from 'assert'
import { test } from 'bun:test'
import { createRetriableTerminalStateRecovery } from '../../app/ts/background/terminalStateRecovery.js'

test('startup terminal recovery failure does not block readiness and the scheduled retry succeeds', async () => {
	let recoveryAttempts = 0
	const reportedErrors: unknown[] = []
	let scheduledRetry: (() => void) | undefined
	let scheduledTimer: ReturnType<typeof setTimeout> | undefined
	const runRecovery = createRetriableTerminalStateRecovery({
		recover: async () => {
			recoveryAttempts += 1
			if (recoveryAttempts === 1) throw new Error('storage temporarily unavailable')
		},
		onFailure: (error) => { reportedErrors.push(error) },
		scheduleRetry: (retry) => {
			scheduledRetry = retry
			scheduledTimer = setTimeout(() => undefined, 60_000)
			return scheduledTimer
		},
	})

	await runRecovery()
	assert.equal(recoveryAttempts, 1)
	assert.equal(reportedErrors.length, 1)
	assert.ok(scheduledRetry !== undefined)

	if (scheduledTimer !== undefined) clearTimeout(scheduledTimer)
	scheduledRetry()
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.equal(recoveryAttempts, 2)
})

test('startup recovery coalesces overlapping attempts and cancels a retry after early success', async () => {
	let attempts = 0
	let fail = true
	let releaseRecovery: (() => void) | undefined
	let retry: (() => void) | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	const runRecovery = createRetriableTerminalStateRecovery({
		recover: async () => {
			attempts += 1
			await new Promise<void>((resolve) => { releaseRecovery = resolve })
			if (fail) throw new Error('storage unavailable')
		},
		onFailure: () => undefined,
		scheduleRetry: (callback, delayMs) => {
			assert.equal(delayMs, 100)
			retry = callback
			timer = setTimeout(() => undefined, 60_000)
			return timer
		},
	})
	try {
		const first = runRecovery()
		const overlapping = runRecovery()
		assert.equal(first, overlapping)
		await Promise.resolve()
		assert.ok(releaseRecovery)
		releaseRecovery()
		await first
		assert.equal(attempts, 1)
		assert.ok(retry)
		fail = false
		const successful = runRecovery()
		await Promise.resolve()
		releaseRecovery()
		await successful
		retry()
		await Promise.resolve()
		assert.equal(attempts, 2, 'A stale timer must not restart completed recovery')
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
})

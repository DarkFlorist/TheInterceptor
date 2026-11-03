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

test('startup terminal recovery stops retrying a pass that keeps failing, with backoff, and reports giving up', async () => {
	let recoveryAttempts = 0
	const failures: boolean[] = []
	const delays: number[] = []
	const runRecovery = createRetriableTerminalStateRecovery({
		recover: async () => {
			recoveryAttempts += 1
			throw new Error('storage unavailable')
		},
		onFailure: (_error, retrying) => { failures.push(retrying) },
		scheduleRetry: (retry, delayMs) => {
			delays.push(delayMs)
			return setTimeout(retry, 0)
		},
	})
	await runRecovery()
	const deadline = Date.now() + 2_000
	while (failures.at(-1) !== false && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(recoveryAttempts, 6, 'a bounded number of passes')
	assert.deepEqual(failures, [true, true, true, true, true, false], 'the last failure gives up')
	assert.deepEqual(delays, [100, 200, 400, 800, 1600], 'with backoff')
})

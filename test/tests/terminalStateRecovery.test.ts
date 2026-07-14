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

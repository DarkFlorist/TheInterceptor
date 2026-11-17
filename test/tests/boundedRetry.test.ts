import * as assert from 'assert'
import { test } from 'bun:test'
import { createBoundedRetries } from '../../app/ts/utils/boundedRetry.js'

const createManualSchedule = () => {
	const scheduled: { readonly retry: () => void, readonly delayMs: number }[] = []
	return { scheduled, scheduleRetry: (retry: () => void, delayMs: number) => { scheduled.push({ retry, delayMs }); return setTimeout(() => undefined, 0) } }
}

test('backs off from the base delay, doubling, and stops at the attempt limit', async () => {
	const { scheduled, scheduleRetry } = createManualSchedule()
	const retries = createBoundedRetries<string>({ baseDelayMs: 50, attemptLimit: 4, scheduleRetry })
	const reports: boolean[] = []
	for (let failure = 0; failure < 4; failure++) await retries.retryAfterFailure('key', () => undefined, (retrying) => reports.push(retrying))
	assert.deepEqual(scheduled.map((retry) => retry.delayMs), [50, 100, 200])
	assert.deepEqual(reports, [true, true, true, false])
	assert.equal(retries.budgetLasts('key'), false)
	retries.reset('key')
	assert.equal(retries.budgetLasts('key'), true)
})

test('reserves the retry before reporting, and counts it as scheduled until it fires', async () => {
	const { scheduled, scheduleRetry } = createManualSchedule()
	const retries = createBoundedRetries<string>({ baseDelayMs: 50, attemptLimit: 6, scheduleRetry })
	let scheduledWhenReported = 0
	let generationRetried: number | undefined
	await retries.retryAfterFailure('key', (generation) => { generationRetried = generation }, () => { scheduledWhenReported = retries.getScheduledRetryCount() })
	assert.equal(scheduledWhenReported, 1)
	scheduled[0]?.retry()
	assert.equal(retries.getScheduledRetryCount(), 0)
	assert.ok(generationRetried !== undefined)
	assert.equal(retries.isCurrent('key', generationRetried), true)
})

test('a retry replaced by a newer failure or a reset does nothing', async () => {
	const { scheduled, scheduleRetry } = createManualSchedule()
	const retries = createBoundedRetries<string>({ baseDelayMs: 50, attemptLimit: 6, scheduleRetry })
	const retried: string[] = []
	await retries.retryAfterFailure('key', () => retried.push('first'), () => undefined)
	await retries.retryAfterFailure('key', () => retried.push('second'), () => undefined)
	scheduled[0]?.retry()
	assert.deepEqual(retried, [])
	scheduled[1]?.retry()
	assert.deepEqual(retried, ['second'])
	await retries.retryAfterFailure('key', () => retried.push('third'), () => undefined)
	retries.reset('key')
	scheduled[2]?.retry()
	assert.deepEqual(retried, ['second'])
})

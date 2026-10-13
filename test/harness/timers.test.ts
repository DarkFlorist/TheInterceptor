import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { installManualTimers } from './timers.js'

describe('installManualTimers', () => {
	test('keeps scheduled callbacks pending until runPending runs them in scheduling order', () => {
		const timers = installManualTimers()
		try {
			const steps: string[] = []
			setTimeout(() => { steps.push('first') }, 50)
			setTimeout(() => { steps.push('second') }, 10)
			assert.equal(timers.pendingCount(), 2)
			assert.deepEqual(steps, [])

			timers.runPending()

			assert.deepEqual(steps, ['first', 'second'])
			assert.equal(timers.pendingCount(), 0)
		} finally {
			timers.restore()
		}
	})

	test('does not run cleared callbacks, including ones cleared by an earlier callback in the same run', () => {
		const timers = installManualTimers()
		try {
			const steps: string[] = []
			const cleared = setTimeout(() => { steps.push('cleared') }, 10)
			clearTimeout(cleared)
			let clearedByFirst: ReturnType<typeof setTimeout> | undefined
			setTimeout(() => {
				steps.push('first')
				clearTimeout(clearedByFirst)
			}, 10)
			clearedByFirst = setTimeout(() => { steps.push('cleared by first') }, 10)

			timers.runPending()

			assert.deepEqual(steps, ['first'])
		} finally {
			timers.restore()
		}
	})

	test('leaves callbacks scheduled during runPending for the next run', () => {
		const timers = installManualTimers()
		try {
			const steps: string[] = []
			setTimeout(() => {
				steps.push('first')
				setTimeout(() => { steps.push('rescheduled') }, 10)
			}, 10)

			timers.runPending()
			assert.deepEqual(steps, ['first'])
			assert.equal(timers.pendingCount(), 1)

			timers.runPending()
			assert.deepEqual(steps, ['first', 'rescheduled'])
		} finally {
			timers.restore()
		}
	})

	test('onlyDelayMs holds back matching timers and passes other delays to the previous timer functions', async () => {
		const timers = installManualTimers({ onlyDelayMs: 30 })
		try {
			const steps: string[] = []
			setTimeout(() => { steps.push('deadline') }, 30)
			const passedThrough = Promise.withResolvers<void>()
			setTimeout(() => {
				steps.push('other delay')
				passedThrough.resolve()
			}, 0)
			const clearedPassThrough = setTimeout(() => { steps.push('cleared other delay') }, 0)
			clearTimeout(clearedPassThrough)
			assert.equal(timers.pendingCount(), 1)

			await passedThrough.promise
			assert.deepEqual(steps, ['other delay'])

			timers.runPending()
			assert.deepEqual(steps, ['other delay', 'deadline'])
		} finally {
			timers.restore()
		}
	})

	test('restore puts back the previous timer functions', () => {
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		const timers = installManualTimers()
		assert.notEqual(globalThis.setTimeout, originalSetTimeout)

		timers.restore()

		assert.equal(globalThis.setTimeout, originalSetTimeout)
		assert.equal(globalThis.clearTimeout, originalClearTimeout)
	})
})

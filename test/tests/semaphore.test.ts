import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Semaphore } from '../../app/ts/utils/semaphore.js'
import { replaceProperty } from '../harness/globals.js'
import { installManualTimers } from '../harness/timers.js'

describe('Semaphore', () => {
	test('cancels a timed wait timeout after a permit arrives', async () => {
		const semaphore = new Semaphore(0)
		const warnings: unknown[][] = []
		const timers = installManualTimers()
		const restoreWarn = replaceProperty(console, 'warn', (...parameters: unknown[]) => { warnings.push(parameters) })
		try {
			const waiting = semaphore.waitFor(10)
			semaphore.signal()
			assert.equal(await waiting, true)
			assert.equal(timers.pendingCount(), 0)
			timers.runPending()
			assert.deepEqual(warnings, [])
		} finally {
			restoreWarn()
			timers.restore()
		}
	})
})

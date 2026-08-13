import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { Semaphore } from '../../app/ts/utils/semaphore.js'

describe('Semaphore', () => {
	test('cancels a timed wait timeout after a permit arrives', async () => {
		const semaphore = new Semaphore(0)
		const warnings: unknown[][] = []
		const originalWarn = console.warn
		console.warn = (...parameters: unknown[]) => { warnings.push(parameters) }
		try {
			const waiting = semaphore.waitFor(10)
			semaphore.signal()
			assert.equal(await waiting, true)
			await new Promise((resolve) => setTimeout(resolve, 20))
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = originalWarn
		}
	})
})

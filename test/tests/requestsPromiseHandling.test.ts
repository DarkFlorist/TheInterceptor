import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { silenceChromeUnCaughtPromise } from '../../app/ts/utils/requests.js'

describe('request promise handling', () => {
	test('silences a rejected promise without creating another rejecting promise', async () => {
		const expectedError = new Error('expected rejection')
		const rejectedPromise = Promise.reject<number>(expectedError)

		const silencedPromise = silenceChromeUnCaughtPromise(rejectedPromise)

		assert.equal(silencedPromise, rejectedPromise)
		await assert.rejects(silencedPromise, (error: unknown) => error === expectedError)
	})

	test('does not emit an unhandled rejection when its return value is ignored', async () => {
		const expectedError = new Error('ignored expected rejection')
		let emittedExpectedRejection = false
		const onUnhandledRejection = (reason: unknown) => {
			if (reason === expectedError) emittedExpectedRejection = true
		}
		process.on('unhandledRejection', onUnhandledRejection)
		try {
			silenceChromeUnCaughtPromise(Promise.reject(expectedError))
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.equal(emittedExpectedRejection, false)
		} finally {
			process.off('unhandledRejection', onUnhandledRejection)
		}
	})
})

import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createConfirmationRunTrackers } from '../../app/ts/background/confirmationRunTracker.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'

const request = (requestId: number) => ({ requestId, requestSocket: { tabId: 1, connectionName: 0n } })

// Each tracker gets the next of these lifetimes, so a test can tell trackers apart.
function createNumberedTrackers() {
	let createdTrackers = 0
	return createConfirmationRunTrackers(() => `tracker ${ ++createdTrackers }`)
}

describe('confirmation run tracker', () => {
	test('orders the runs of each request on its own', () => {
		const trackers = createNumberedTrackers()
		assert.deepEqual(trackers.reserve(request(1)), { lifetime: 'tracker 1', sequence: 1 })
		assert.deepEqual(trackers.reserve(request(1)), { lifetime: 'tracker 1', sequence: 2 })
		assert.deepEqual(trackers.reserve(request(2)), { lifetime: 'tracker 2', sequence: 1 })
		assert.deepEqual(trackers.reserve(request(1)), { lifetime: 'tracker 1', sequence: 3 })
	})

	test('a later run aborts the run of its request in flight, an earlier run does not start, and runs of other requests are left alone', () => {
		const trackers = createNumberedTrackers()
		const earlier = trackers.reserve(request(1))
		const later = trackers.reserve(request(1))
		const otherRequestRun = trackers.startRun(request(2), trackers.reserve(request(2)))

		const earlierRun = trackers.startRun(request(1), earlier)
		const laterRun = trackers.startRun(request(1), later)
		assert.equal(earlierRun?.signal.aborted, true)
		assert.equal(earlierRun?.signal.reason, NEW_BLOCK_ABORT)
		assert.equal(laterRun?.signal.aborted, false)
		assert.equal(otherRequestRun?.signal.aborted, false)
		assert.equal(trackers.startRun(request(1), earlier), undefined)
		assert.equal(trackers.getInFlightAbortController(request(1)), laterRun)

		// The replaced run ending does not end the run that replaced it.
		if (earlierRun === undefined || laterRun === undefined) throw new Error('Missing runs')
		trackers.finishRun(request(1), earlierRun)
		assert.equal(trackers.getInFlightAbortController(request(1)), laterRun)
		trackers.finishRun(request(1), laterRun)
		assert.equal(trackers.getInFlightAbortController(request(1)), undefined)
	})

	test('a disposed tracker is replaced by one of another lifetime, so no later run takes the id of an earlier one', () => {
		const trackers = createNumberedTrackers()
		trackers.reserve(request(1))
		const lastRunBeforeDisposal = trackers.reserve(request(1))
		trackers.dispose(request(1))
		const firstRunAfterDisposal = trackers.reserve(request(1))
		assert.notEqual(firstRunAfterDisposal.lifetime, lastRunBeforeDisposal.lifetime)
		assert.equal(trackers.getInFlightAbortController(request(1)), undefined)
	})

	test('a run reserved before its request\'s tracker was disposed is not started and does not recreate the tracker', () => {
		const trackers = createNumberedTrackers()
		const run = trackers.reserve(request(1))
		trackers.dispose(request(1))

		assert.equal(trackers.startRun(request(1), run), undefined)
		assert.equal(trackers.has(request(1)), false)
	})

	test('a run of an obsolete tracker is not started, while a run of the current tracker is', () => {
		const trackers = createNumberedTrackers()
		const obsoleteRun = trackers.reserve(request(1))
		trackers.dispose(request(1))
		const currentRun = trackers.reserve(request(1))
		// The obsolete run has a lower or equal sequence and another lifetime; it must not start, nor abort the current one.
		const current = trackers.startRun(request(1), currentRun)

		assert.equal(trackers.startRun(request(1), obsoleteRun), undefined)
		assert.equal(current?.signal.aborted, false)
		assert.equal(trackers.getInFlightAbortController(request(1)), current)
	})
})

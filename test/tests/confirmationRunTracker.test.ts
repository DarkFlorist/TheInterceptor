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

describe('confirmation run lifecycle', () => {
	// A queue that holds the given requests, whose disposal check records each request it was asked about.
	async function createLifecycle(storedRequests: readonly ReturnType<typeof request>[]) {
		const { createConfirmationRunLifecycle } = await import('../../app/ts/background/confirmationRunLifecycle.js')
		const trackers = createNumberedTrackers()
		const checked: number[] = []
		const lifecycle = createConfirmationRunLifecycle(trackers, async (uniqueRequestIdentifier, dispose) => {
			checked.push(uniqueRequestIdentifier.requestId)
			if (!storedRequests.some((stored) => stored.requestId === uniqueRequestIdentifier.requestId)) dispose()
		})
		return { trackers, checked, lifecycle }
	}

	test('reserves the run before the work starts, and disposes of the tracker of a request that was never stored', async () => {
		const { trackers, checked, lifecycle } = await createLifecycle([])
		const result = lifecycle.withConfirmationRun(request(1), async (run) => {
			assert.deepEqual(run, { lifetime: 'tracker 1', sequence: 1 })
			assert.equal(trackers.has(request(1)), true)
			return 'done'
		})
		// The run is reserved synchronously, when the entry calls the lifecycle.
		assert.equal(trackers.has(request(1)), true)
		assert.equal(await result, 'done')
		assert.deepEqual(checked, [1])
		assert.equal(trackers.has(request(1)), false)
	})

	test('keeps the tracker of a request that is still stored', async () => {
		const { trackers, lifecycle } = await createLifecycle([request(1)])
		await lifecycle.withConfirmationRun(request(1), async () => undefined)
		assert.equal(trackers.has(request(1)), true)
		assert.deepEqual(await lifecycle.withConfirmationRun(request(1), async (run) => run), { lifetime: 'tracker 1', sequence: 2 })
	})

	test('disposes of the tracker of a request that is gone even when the work throws, and passes the error on', async () => {
		const { trackers, checked, lifecycle } = await createLifecycle([])
		await assert.rejects(lifecycle.withConfirmationRun(request(1), async () => { throw new Error('work failed') }), /work failed/u)
		assert.deepEqual(checked, [1])
		assert.equal(trackers.has(request(1)), false)
	})

	test('reserves one run for each of several requests and releases each of them', async () => {
		const { trackers, checked, lifecycle } = await createLifecycle([request(2)])
		const runs = await lifecycle.withConfirmationRuns([request(1), request(2)], async (reserved) => reserved)
		assert.deepEqual(runs, [{ lifetime: 'tracker 1', sequence: 1 }, { lifetime: 'tracker 2', sequence: 1 }])
		assert.deepEqual(checked, [1, 2])
		assert.equal(trackers.has(request(1)), false)
		assert.equal(trackers.has(request(2)), true)
	})

	// Every entry point takes its runs through the lifecycle, so none can forget to release them, and only a request leaving the queue disposes of a stored request's tracker.
	test('only the lifecycle reserves runs and disposes of trackers, apart from the removal of a request from the queue', async () => {
		const appDirectory = new URL('../../app/ts/', import.meta.url).pathname
		const reservers: string[] = []
		const disposers: string[] = []
		for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appDirectory })) {
			if (file === 'background/confirmationRunTracker.ts') continue
			const source = await Bun.file(`${ appDirectory }${ file }`).text()
			// The run trackers are confirmationRuns, the background's instance, or a lifecycle's trackers.
			if (/\b(?:confirmationRuns|trackers)\.reserve\(/u.test(source)) reservers.push(file)
			for (const _match of source.matchAll(/\b(?:confirmationRuns|trackers)\.dispose\(/gu)) disposers.push(file)
		}
		assert.deepEqual(reservers, ['background/confirmationRunLifecycle.ts'])
		assert.deepEqual(disposers.toSorted(), ['background/confirmationRunLifecycle.ts', 'background/storageVariables.ts'])
		const storageVariablesSource = await Bun.file(`${ appDirectory }background/storageVariables.ts`).text()
		const removal = storageVariablesSource.slice(storageVariablesSource.indexOf('export async function removePendingTransactionOrMessage('), storageVariablesSource.indexOf('\n}\n', storageVariablesSource.indexOf('export async function removePendingTransactionOrMessage(')))
		assert.match(removal, /confirmationRuns\.dispose\(uniqueRequestIdentifier\)/u)
	})
})

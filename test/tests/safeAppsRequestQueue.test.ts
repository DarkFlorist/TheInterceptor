import * as assert from 'assert'
import { test } from 'bun:test'
import { createSafeAppsRequestQueue } from '../../app/inpage/ts/safeAppsRequestQueue.js'
import { SAFE_APPS_PENDING_REQUEST_LIMIT, SAFE_APPS_REQUEST_TIMEOUT_MS } from '../../app/inpage/ts/safeAppsProtocol.js'

type Request = { readonly id: string, readonly method: string }
function createQueueHarness(replaceOldestSafeInfo = false, scheduled = true) {
	const callbacks: (() => void)[] = []
	const active = new Set<number>()
	const rejected: { readonly id: string, readonly error: string, readonly reason: string }[] = []
	const queue = createSafeAppsRequestQueue<Request>({
		replaceOldestSafeInfo,
		onRejected: ({ id }, error, reason) => rejected.push({ id, error, reason }),
		...(scheduled ? { timers: {
			setTimeout: (callback: () => void, delay: number) => {
				assert.equal(delay, SAFE_APPS_REQUEST_TIMEOUT_MS)
				callbacks.push(callback)
				active.add(callbacks.length)
				return callbacks.length
			},
			clearTimeout: (id: number) => { active.delete(id) },
		} } : {}),
	})
	return { queue, callbacks, active, rejected }
}

for (const scheduled of [true, false]) {
	test(`Safe Apps queue bounds requests and preserves the original duplicate ID (${ scheduled ? 'scheduled' : 'lazy' } expiry)`, () => {
		const { queue, active, rejected } = createQueueHarness(false, scheduled)
		const first = { id: '0', method: 'getChainInfo' }
		assert.equal(queue.add(first), true)
		assert.equal(queue.add({ id: '0', method: 'sendTransactions' }), false)
		for (let index = 1; index < SAFE_APPS_PENDING_REQUEST_LIMIT; index++) assert.equal(queue.add({ id: `${ index }`, method: 'getChainInfo' }), true)
		assert.equal(queue.add({ id: 'overflow', method: 'getSafeInfo' }), false)
		assert.deepEqual(rejected.map(({ id, reason }) => [id, reason]), [['0', 'duplicate'], ['overflow', 'capacity']])
		assert.equal(queue.take('0'), first)
		assert.equal(queue.add({ id: 'retry', method: 'getSafeInfo' }), true)
		assert.equal(queue.drain().length, SAFE_APPS_PENDING_REQUEST_LIMIT)
		assert.deepEqual(queue.values(), [])
		assert.equal(active.size, 0)
	})
}

test('Safe Apps queue replaces only the oldest Safe info probe and never an operation', () => {
	const { queue, rejected, active } = createQueueHarness(true)
	for (let index = 0; index < SAFE_APPS_PENDING_REQUEST_LIMIT; index++) queue.add({ id: `${ index }`, method: index === 1 || index === 2 ? 'getSafeInfo' : 'sendTransactions' })
	assert.equal(queue.add({ id: 'new-operation', method: 'signMessage' }), true)
	assert.deepEqual(rejected.map(({ id, reason }) => [id, reason]), [['1', 'superseded']])
	assert.equal(active.has(2), false)
	assert.equal(queue.add({ id: 'new-probe', method: 'getSafeInfo' }), true)
	assert.equal(queue.take('new-probe')?.method, 'getSafeInfo')
	queue.add({ id: 'fill', method: 'sendTransactions' })
	assert.equal(queue.add({ id: 'overflow', method: 'getSafeInfo' }), false)
	assert.deepEqual(rejected.map(({ id, reason }) => [id, reason]), [['1', 'superseded'], ['2', 'superseded'], ['overflow', 'capacity']])
})

test('Safe Apps queue releases timers on cancellation and ignores old callbacks after ID reuse', () => {
	const { queue, callbacks, rejected, active } = createQueueHarness()
	queue.add({ id: 'reused', method: 'getSafeInfo' })
	assert.equal(queue.take('reused')?.id, 'reused')
	assert.equal(active.size, 0)
	queue.add({ id: 'reused', method: 'getChainInfo' })
	callbacks[0]?.()
	assert.equal(queue.values().length, 1)
	assert.deepEqual(rejected, [])
	callbacks[1]?.()
	callbacks[1]?.()
	assert.deepEqual(rejected, [{ id: 'reused', error: 'Safe Apps request timed out.', reason: 'expired' }])
	assert.equal(active.size, 0)
	assert.equal(queue.add({ id: 'after-expiry', method: 'getSafeInfo' }), true)
})

test('Safe Apps queue lazy expiry uses the same deadline and rejection as timer expiry', () => {
	const originalNow = Date.now
	let now = 0
	Date.now = () => now
	try {
		const { queue, rejected } = createQueueHarness(false, false)
		queue.add({ id: 'expired', method: 'getSafeInfo' })
		now = SAFE_APPS_REQUEST_TIMEOUT_MS - 1
		queue.expire()
		assert.deepEqual(rejected, [])
		now += 1
		queue.add({ id: 'fresh', method: 'getChainInfo' })
		assert.deepEqual(rejected, [{ id: 'expired', error: 'Safe Apps request timed out.', reason: 'expired' }])
		assert.deepEqual(queue.drain(), [{ id: 'fresh', method: 'getChainInfo' }])
	} finally { Date.now = originalNow }
})

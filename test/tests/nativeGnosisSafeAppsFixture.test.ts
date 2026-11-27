import * as assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'bun:test'
import { createNativeGnosisSafeAppsFixtureClient } from '../fixtures/nativeGnosisSafeAppsClient.js'

function fixtureClient() {
	let now = 0
	let nextId = 0
	let nextTimer = 0
	const timers = new Map<number, { callback: () => void, at: number }>()
	const listeners = new Set<(event: { source: object, origin: string, data: unknown }) => void>()
	const messages: { id: string, method: string }[] = []
	const parent = { postMessage: (message: { id: string, method: string }) => { messages.push(message) } }
	const client = runInNewContext(`(${ createNativeGnosisSafeAppsFixtureClient.toString() })('moz-extension://fixture')`, {
		window: { parent, addEventListener: (_name: string, listener: (event: { source: object, origin: string, data: unknown }) => void) => listeners.add(listener), removeEventListener: (_name: string, listener: (event: { source: object, origin: string, data: unknown }) => void) => listeners.delete(listener) },
		crypto: { randomUUID: () => `request-${ ++nextId }` },
		performance: { now: () => now },
		setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id },
		clearTimeout: (id: number) => timers.delete(id),
	})
	return {
		client, messages,
		advance: (elapsed: number) => {
			now += elapsed
			for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
		},
		reply: (value: unknown) => { for (const listener of [...listeners]) listener({ source: parent, origin: 'moz-extension://fixture', data: value }) },
	}
}

test('native fixture keeps an approval pending past the old 15-second discovery deadline and accepts its single terminal reply', async () => {
	const fixture = fixtureClient()
	let settled = false
	const pending = fixture.client.request('sendTransactions', { txs: [] }).then((value: unknown) => { settled = true; return value })
	fixture.advance(20_000)
	await Promise.resolve()
	assert.equal(settled, false)
	assert.equal(fixture.messages.length, 1, 'The fixture must not replay a pending mutation')
	const reply = { id: fixture.messages[0]?.id, success: true, data: { safeTxHash: 'result' } }
	fixture.reply(reply)
	assert.equal(await pending, reply)
	assert.equal(settled, true)
	assert.equal(fixture.messages.length, 1)
})

test('native fixture still bounds discovery and records a late product reply separately from an expired SDK promise', async () => {
	const fixture = fixtureClient()
	const rejected = assert.rejects(fixture.client.request('getSafeInfo'), /SDK deadline expired/)
	fixture.advance(15_001)
	await rejected
	fixture.reply({ id: fixture.messages[0]?.id, success: true, data: {} })
	assert.equal(fixture.client.deliveries.length, 1)
	assert.equal(fixture.client.replies.length, 0)
	assert.equal(fixture.client.timings[0].expired, 15_001)
})

test('the old explicit 15-second mutation deadline loses a valid approval result while the default mutation contract accepts it', async () => {
	const fixture = fixtureClient()
	const rejected = assert.rejects(fixture.client.request('sendTransactions', { txs: [] }, 15_000), /SDK deadline expired/)
	fixture.advance(16_000)
	await rejected
	fixture.reply({ id: fixture.messages[0]?.id, success: true })
	assert.equal(fixture.client.deliveries.length, 1)
	assert.equal(fixture.client.replies.length, 0)
})

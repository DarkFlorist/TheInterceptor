import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createPageExtensions, registerPageExtension } from '../../app/inpage/ts/pageExtensions.js'

// The core can start without any HTTP extension and never needs a fetch implementation.
test('page extension registration delivers current and later context through one read-only transport', async () => {
	const host = {}
	const requests: unknown[] = []
	const manager = createPageExtensions(host, async (chain, request) => { requests.push({ chain, request }); return 'result' })
	const initial = { rpcInterception: { chainId: '0x1' } }
	manager.setContext(initial)
	const contexts: unknown[] = []
	let installs = 0
	let disposed = 0
	registerPageExtension(host, 'http', (requestRpc) => {
		installs++
		void requestRpc('0x1', { method: 'eth_getBalance' })
		return { setContext: (value) => { contexts.push(value) }, dispose: () => { disposed++ } }
	})
	registerPageExtension(host, 'http', () => { throw new Error('Duplicate installation') })
	manager.setContext(undefined)
	assert.deepEqual(contexts, [initial, undefined])
	assert.deepEqual(requests, [{ chain: '0x1', request: { method: 'eth_getBalance' } }])
	assert.equal(installs, 1)
	manager.dispose()
	manager.setContext(initial)
	assert.deepEqual(contexts, [initial, undefined])
	assert.equal(disposed, 1)
	assert.throws(() => registerPageExtension(host, 'http', () => { throw new Error('Should not install') }), /provider must initialize/)
})

test('page extension teardown does not remove a replacement provider registration', () => {
	const host = {}
	const first = createPageExtensions(host, async () => undefined)
	const second = createPageExtensions(host, async () => undefined)
	first.dispose()
	const contexts: unknown[] = []
	registerPageExtension(host, 'http', () => ({ setContext: (value) => { contexts.push(value) }, dispose: () => undefined }))
	second.setContext('current')
	assert.deepEqual(contexts, ['current'])
})


test('registration preserves startup waiting until the first explicit context publication', () => {
	const host = {}
	const manager = createPageExtensions(host, async () => undefined)
	const contexts: unknown[] = []
	registerPageExtension(host, 'http', () => ({ setContext: (value) => { contexts.push(value) }, dispose: () => undefined }))
	assert.deepEqual(contexts, [], 'absence of a publication must not release a native host startup read to the network')
	manager.setContext(undefined)
	assert.deepEqual(contexts, [undefined], 'an actual disabled/revoked publication must still release native reads')
})

import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createPageExtensions } from '../../app/inpage/ts/pageExtensions.js'

test('private composition delivers context and RPC only to its supplied factories', async () => {
	const requests: unknown[] = []
	const contexts: unknown[] = []
	let disposed = 0
	const manager = createPageExtensions(async (request) => { requests.push(request); return 'result' }, [(requestRpc) => {
		void requestRpc({ method: 'read' })
		return { setContext: (value) => { contexts.push(value) }, dispose: () => { disposed++ } }
	}])
	assert.equal('register' in manager, false, 'page scripts have no dynamic registration entrypoint')
	assert.deepEqual(contexts, [], 'no implicit disabled context before the first publication')
	manager.setContext({ enabled: true })
	manager.setContext(undefined)
	assert.deepEqual(contexts, [{ enabled: true }, undefined])
	assert.deepEqual(requests, [{ method: 'read' }])
	manager.dispose()
	manager.dispose()
	manager.setContext('late')
	assert.equal(disposed, 1)
	assert.deepEqual(contexts, [{ enabled: true }, undefined])
})

test('the core can initialize and publish without any HTTP extension or page registration', () => {
	const manager = createPageExtensions(async () => undefined, [])
	manager.setContext(undefined)
	manager.dispose()
})

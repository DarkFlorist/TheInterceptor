import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'bun:test'

for (const origin of ['https://app.safe.global', 'https://app.request.finance', 'https://attacker.example']) for (const parentSource of [true, false]) test(`Request Finance fixture filters SDK reply origin=${ origin }, parent=${ parentSource }`, async () => {
	const html = fs.readFileSync('test/fixtures/requestFinanceGnosisSafeDiscovery.html', 'utf8')
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
	assert.ok(script)
	let listener: ((event: unknown) => void) | undefined
	const parent = { postMessage: ({ id }: { id: string }) => listener?.({ source: parentSource ? parent : window, origin, data: { id, version: '9.1.0', success: true, data: { safeAddress: '0x123' } } }) }
	const window = { parent, addEventListener: (_name: string, callback: (event: unknown) => void) => { listener = callback }, removeEventListener: () => { listener = undefined } }
	const context = { window, location: { origin: 'https://app.request.finance' }, crypto, performance: { now: () => 0 }, document: { body: { firstElementChild: { textContent: '' } } }, setTimeout: () => 0 }
	runInNewContext(script, context)
	await new Promise((resolve) => setTimeout(resolve, 0))
	const state = Reflect.get(context, '__interceptorChromeCommunicationState')
	const accepted = origin === 'https://app.safe.global' && parentSource
	assert.equal(state.phase, accepted ? 'safe-only-granted' : 'requesting-safe-only')
	assert.equal(state.sdkReply !== undefined, accepted)
})

test('Request Finance fixture records late authorized metadata without disguising its native deadline failure', async () => {
	const script = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync('test/fixtures/requestFinanceGnosisSafeDiscovery.html', 'utf8'))?.[1]
	assert.ok(script)
	let listener: ((event: unknown) => void) | undefined
	let pendingId = ''
	const parent = { postMessage: ({ id }: { id: string }) => { pendingId = id } }
	const window = { parent, addEventListener: (_name: string, callback: (event: unknown) => void) => { listener = callback }, removeEventListener: () => { listener = undefined } }
	const context = { window, crypto, location: { origin: 'https://app.request.finance' }, performance: { now: () => 0 }, document: { body: { firstElementChild: { textContent: '' } } }, setTimeout: (resolve: () => void) => { resolve(); return 0 } }
	runInNewContext(script, context)
	await new Promise((resolve) => setTimeout(resolve, 0))
	const state = Reflect.get(context, '__interceptorChromeCommunicationState')
	assert.equal(state.phase, 'error')
	assert.equal(state.error, 'Site Gnosis Safe discovery reached its 200 ms deadline.')
	assert.equal(state.sdkReply, undefined)
	listener?.({ source: parent, origin: 'https://app.safe.global', data: { id: pendingId, version: '9.1.0', success: true, data: { safeAddress: '0x123' } } })
	assert.equal(state.sdkReply.safeInfo.safeAddress, '0x123')
	assert.equal(state.phase, 'error', 'late metadata must not turn a timed-out connection into success')
})

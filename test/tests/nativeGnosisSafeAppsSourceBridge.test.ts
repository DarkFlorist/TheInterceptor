import { createGnosisSafeAppsBridgeMessage, parseGnosisSafeAppsBridgeMessage, createGnosisSafeAppsCancellation, createNativeGnosisSafeAppsSourceDisconnected } from '../../app/shared/ts/gnosisSafeAppsBridgeProtocol.js'
import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createNativeGnosisSafeAppsSourceBridge } from '../../app/inpage/ts/nativeGnosisSafeAppsSourceBridge.js'
import { GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT, GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS, parseGnosisSafeAppsRequest } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'

function sourceBridge() {
	const listeners = new Set<(event: Event) => void>()
	const posted: unknown[] = []
	const timers = new Map<number, { callback: () => void, delay: number }>()
	let nextId = 0
	let nextTimer = 0
	const windowObject = {
		location: { origin: 'https://app.example' },
		addEventListener: (_name: 'message', listener: (event: Event) => void) => { listeners.add(listener) },
		removeEventListener: (_name: 'message', listener: (event: Event) => void) => { listeners.delete(listener) },
		postMessage: (value: unknown) => { posted.push(value) },
	}
	const bridge = createNativeGnosisSafeAppsSourceBridge(windowObject, () => `private-${ ++nextId }`, {
		setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
		clearTimeout: (id) => { timers.delete(id) },
	})
	return {
		bridge, posted, listeners, timers,
		receive(data: unknown, origin = windowObject.location.origin, source: object = windowObject) {
			const event = new MessageEvent('message', { data, origin })
			Object.defineProperty(event, 'source', { value: source })
			for (const listener of [...listeners]) listener(event)
		},
	}
}
const sdk = (id: string, method: string) => ({ id, method, env: { sdkVersion: '9.1.0' } })

function forwarded(value: unknown) {
	const wrapper = parseGnosisSafeAppsBridgeMessage(value)
	assert.ok(wrapper)
	const parsed = parseGnosisSafeAppsRequest(wrapper.envelope)
	assert.ok(parsed !== undefined && 'request' in parsed)
	return { ...parsed.request, bridgeToken: wrapper.bridgeToken }
}

test('native source requests use the shared capacity and one authenticated transport subscription', async () => {
	const fixture = sourceBridge()
	const replies = []
	for (let index = 0; index < GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT; index++) replies.push(fixture.bridge.request(sdk(String(index), 'sendTransactions')))
	assert.equal(fixture.listeners.size, 1)
	assert.equal(fixture.timers.size, 0)
	await assert.rejects(fixture.bridge.request(sdk('overflow', 'sendTransactions')), /Too many pending/)
	assert.equal(fixture.posted.length, GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT)
	fixture.bridge.cancelPending()
	assert.deepEqual(await Promise.all(replies), Array.from({ length: GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT }, (_, index) => createNativeGnosisSafeAppsSourceDisconnected(String(index))))
	assert.equal(fixture.listeners.size, 0)
})

test('native source discovery uses its canonical round-trip deadline and cancellation while mutations retain their terminal reply', async () => {
	const fixture = sourceBridge()
	const mutation = fixture.bridge.request(sdk('mutation', 'sendTransactions'))
	const discovery = assert.rejects(fixture.bridge.request(sdk('discovery', 'getSafeInfo')), /timed out/)
	const mutationWire = forwarded(fixture.posted[0])
	const discoveryWire = forwarded(fixture.posted[1])
	assert.equal(fixture.timers.size, 1)
	const timeout = [...fixture.timers.values()][0]
	assert.equal(timeout?.delay, GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS)
	timeout?.callback()
	await discovery
	assert.deepEqual(fixture.posted[2], createGnosisSafeAppsBridgeMessage(createGnosisSafeAppsCancellation(discoveryWire.id), discoveryWire.bridgeToken))
	let settled = false
	void mutation.then(() => { settled = true })
	fixture.receive(createGnosisSafeAppsBridgeMessage({ id: mutationWire.id, success: true }, 'wrong'))
	fixture.receive(createGnosisSafeAppsBridgeMessage({ id: mutationWire.id, success: true }, mutationWire.bridgeToken), 'https://foreign.example')
	fixture.receive(createGnosisSafeAppsBridgeMessage({ id: mutationWire.id, success: true }, mutationWire.bridgeToken), undefined, {})
	await Promise.resolve()
	assert.equal(settled, false)
	fixture.receive(createGnosisSafeAppsBridgeMessage({ id: mutationWire.id, success: true, data: 'approved' }, mutationWire.bridgeToken))
	assert.deepEqual(await mutation, { id: 'mutation', success: true, data: 'approved' })
	assert.equal(fixture.listeners.size, 0)
	assert.equal(fixture.posted.length, 3, 'No mutation replay after discovery expiry')
})

test('native source cleanup permits a fresh request after a restored source page and rejects malformed envelopes', async () => {
	const fixture = sourceBridge()
	await assert.rejects(fixture.bridge.request({ ...sdk('bad', 'getSafeInfo'), env: { sdkVersion: 'invalid' } }), /Invalid native/)
	assert.equal(fixture.posted.length, 0)
	const first = fixture.bridge.request(sdk('before-hide', 'sendTransactions'))
	fixture.bridge.cancelPending()
	assert.deepEqual(JSON.parse(JSON.stringify(await first)), createNativeGnosisSafeAppsSourceDisconnected('before-hide'))
	const restored = fixture.bridge.request(sdk('restored', 'getChainInfo'))
	const request = forwarded(fixture.posted.at(-1))
	fixture.receive(createGnosisSafeAppsBridgeMessage({ id: request.id, success: false, error: 'restored rejection' }, request.bridgeToken))
	assert.deepEqual(await restored, { id: 'restored', success: false, error: 'restored rejection' })
	assert.equal(fixture.listeners.size, 0)
	assert.equal(fixture.timers.size, 0)
})

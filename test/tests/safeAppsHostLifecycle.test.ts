import * as assert from 'assert'
import { test } from 'bun:test'

import { installSafeAppsHost } from '../../app/inpage/ts/safeAppsHost.js'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'

test('Safe Apps host respects site discovery deadlines and relays eventual SDK replies within its capacity', async () => {
	const { fakeWindow, framePort, origin, activeTimeouts, fireTimeouts, postMessage, frameWasAppended, restoreGlobals } = createSafeHostHarness()
	try {
		installSafeAppsHost()
		assert.equal(frameWasAppended(), true)
		assert.notEqual(Reflect.get(fakeWindow, 'parent'), fakeWindow)
		let repliedToSdk = false
		const forwardedBulkRequests = new Set<string>()
		const bulkReplies = new Set<string>()
		let overflowRejected = false
		let overflowSdkCallbackReceived = false
		const timedOutRequestIds = new Set<string>()
		fakeWindow.addEventListener('message', (event) => {
			if (!('data' in event) || !('source' in event)) return
			if (event.source === fakeWindow && typeof event.data === 'object' && event.data !== null && 'method' in event.data && event.data.method === 'getSafeInfo' && 'id' in event.data && event.data.id === 'sdk-request') {
				postMessage({ id: 'sdk-request', success: true, data: { safeAddress: '0x123' }, version: '9.1.0' }, origin)
			}
			if (event.source === fakeWindow && typeof event.data === 'object' && event.data !== null && 'method' in event.data && event.data.method === 'getChainInfo' && 'id' in event.data && typeof event.data.id === 'string' && event.data.id.startsWith('bulk-')) {
				forwardedBulkRequests.add(event.data.id)
				postMessage({ id: event.data.id, success: true, data: {}, version: '9.1.0' }, origin)
			}
			if (event.source === framePort && typeof event.data === 'object' && event.data !== null && 'id' in event.data && typeof event.data.id === 'string' && event.data.id.startsWith('bulk-')) {
				bulkReplies.add(event.data.id)
				if ('success' in event.data && event.data.success === false) overflowRejected = true
			}
			if (event.source === framePort && typeof event.data === 'object' && event.data !== null && 'id' in event.data && typeof event.data.id === 'string' && event.data.id.startsWith('stalled-') && 'success' in event.data && event.data.success === false) timedOutRequestIds.add(event.data.id)
			if (event.source === framePort && typeof event.data === 'object' && event.data !== null && 'success' in event.data && event.data.success === true) repliedToSdk = true
		})
		framePort.postMessage({ id: 'sdk-request', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		Reflect.get(fakeWindow, 'setTimeout')(() => undefined, 200)
		assert.deepEqual(activeTimeouts(), [200])
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		assert.equal(repliedToSdk, true)
		Reflect.get(fakeWindow, 'setTimeout')(() => undefined, 200)
		assert.deepEqual(activeTimeouts(), [200, 200])
		for (const approved of [true, false]) {
			const id = `delayed-discovery-${ approved }`
			const sdkReplies: boolean[] = []
			const sdkReply = new Promise<boolean>((resolve) => {
				const listener = (event: Event) => {
					if (!('source' in event) || event.source !== framePort || !('data' in event) || typeof event.data !== 'object' || event.data === null || !('id' in event.data) || event.data.id !== id || !('success' in event.data) || typeof event.data.success !== 'boolean') return
					fakeWindow.removeEventListener('message', listener)
					sdkReplies.push(event.data.success)
					resolve(event.data.success)
				}
				fakeWindow.addEventListener('message', listener)
				framePort.postMessage({ id, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
			})
			// Respect the site's discovery deadline even when the SDK waits for eventual approval.
			const discovery = Promise.race([sdkReply, new Promise<boolean>((resolve) => {
				Reflect.get(fakeWindow, 'setTimeout')(() => resolve(false), 200)
			})])
			let discoverySettled = false
			void discovery.then(() => { discoverySettled = true })
			await new Promise((resolve) => setTimeout(resolve, 0))
			fireTimeouts(200)
			fireTimeouts(10_000)
			fireTimeouts(10_500)
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			assert.equal(discoverySettled, true)
			assert.equal(await discovery, false)
			assert.deepEqual(sdkReplies, [])
			postMessage({ id, success: approved, ...(approved ? { data: { safeAddress: '0x123' } } : { error: 'User rejected access.' }), version: '9.1.0' }, origin)
			assert.equal(await sdkReply, approved)
			assert.equal(await discovery, false)
			assert.deepEqual(sdkReplies, [approved])
		}
		for (let index = 0; index < 33; index++) {
			framePort.postMessage({ id: `bulk-${ index }`, method: 'getChainInfo', env: { sdkVersion: '9.1.0' } })
			if (index === 32) fakeWindow.addEventListener('message', (event) => {
				if ('source' in event && event.source === framePort && 'data' in event && typeof event.data === 'object' && event.data !== null && 'id' in event.data && event.data.id === 'bulk-32') overflowSdkCallbackReceived = true
			})
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		assert.equal(forwardedBulkRequests.size, 32)
		assert.equal(bulkReplies.size, 33)
		assert.equal(overflowRejected, true)
		assert.equal(overflowSdkCallbackReceived, true)
		for (let index = 0; index < 32; index++) framePort.postMessage({ id: `stalled-${ index }`, method: 'getChainInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		fireTimeouts(5 * 60_000)
		assert.equal(timedOutRequestIds.size, 32)
		let resumedRequestForwarded = false
		fakeWindow.addEventListener('message', (event) => {
			if ('source' in event && event.source === fakeWindow && 'data' in event && typeof event.data === 'object' && event.data !== null && 'id' in event.data && event.data.id === 'resumed-request') resumedRequestForwarded = true
		})
		framePort.postMessage({ id: 'resumed-request', method: 'getChainInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		assert.equal(resumedRequestForwarded, true)
	} finally {
		restoreGlobals()
	}
})

test('Safe Apps host preserves every site timer, including the first 200 ms callback after discovery', async () => {
	const { fakeWindow, framePort, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		installSafeAppsHost()
		const calls: unknown[][] = []
		const handler = (...args: unknown[]) => { calls.push(args) }
		const argument = { value: 'callback argument' }
		Reflect.get(fakeWindow, 'setTimeout')(handler, 200, 'before discovery', argument)
		framePort.postMessage({ id: 'timer-discovery', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		Reflect.get(fakeWindow, 'setTimeout')(handler, 100, 'different delay', argument)
		Reflect.get(fakeWindow, 'setTimeout')(handler, 200, 'discovery fallback', argument)
		Reflect.get(fakeWindow, 'setTimeout')(handler, 200, 'second timer', argument)
		await Promise.resolve()
		Reflect.get(fakeWindow, 'setTimeout')(handler, 200, 'after discovery microtask', argument)
		const cancelledId = Reflect.get(fakeWindow, 'setTimeout')(handler, 200, 'cancelled', argument)
		Reflect.get(fakeWindow, 'clearTimeout')(cancelledId)
		fireTimeouts(100)
		fireTimeouts(200)
		assert.deepEqual(calls, [
			['different delay', argument],
			['before discovery', argument],
			['discovery fallback', argument],
			['second timer', argument],
			['after discovery microtask', argument],
		])
		assert.equal(calls.every((args) => args[1] === argument), true)
	} finally {
		restoreGlobals()
	}
})

test('abandoned discovery probes leave capacity for operations and all remaining probes expire', async () => {
	const { fakeWindow, framePort, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		installSafeAppsHost()
		const forwarded = new Set<string>()
		const rejected = new Set<string>()
		fakeWindow.addEventListener('message', (event) => {
			if (!('data' in event) || !('source' in event) || typeof event.data !== 'object' || event.data === null || !('id' in event.data) || typeof event.data.id !== 'string') return
			if (event.source === fakeWindow && 'method' in event.data) forwarded.add(event.data.id)
			if (event.source === framePort && 'success' in event.data && event.data.success === false) rejected.add(event.data.id)
		})
		for (let index = 0; index < 80; index++) framePort.postMessage({ id: `abandoned-${ index }`, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		framePort.postMessage({ id: 'operation-after-retries', method: 'getChainInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(forwarded.size, 81)
		assert.equal(rejected.size, 49)
		fireTimeouts(5 * 60_000)
		assert.equal(rejected.size, 81)
		framePort.postMessage({ id: 'after-expiry', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(forwarded.has('after-expiry'), true)
	} finally { restoreGlobals() }
})

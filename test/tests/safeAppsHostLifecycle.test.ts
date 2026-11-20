import * as assert from 'assert'
import { test } from 'bun:test'
import SafeAppsSDK from '@safe-global/safe-apps-sdk'

import { hostSafeAppsForPageLifetime, installSafeAppsHost, SAFE_APPS_HOST_MARKER } from '../../app/inpage/ts/safeAppsHost.js'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'

test('reused SDK IDs get distinct bridge tokens and stale provider replies cannot settle the retry', async () => {
	const { fakeWindow, framePort, emitMessage, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const forwarded: { readonly id: string, readonly bridgeToken: string }[] = []
		const replies: unknown[] = []
		fakeWindow.addEventListener('message', ({ data, source }) => {
			if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== 'reused') return
			if (source === fakeWindow && 'method' in data && 'bridgeToken' in data && typeof data.bridgeToken === 'string') forwarded.push({ id: data.id, bridgeToken: data.bridgeToken })
			if (source === framePort && 'success' in data) replies.push(data)
		})
		const sdkRequest = { id: 'reused', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }
		framePort.postMessage(sdkRequest)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(forwarded.length, 1)
		fireTimeouts(5 * 60_000)
		framePort.postMessage(sdkRequest)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(forwarded.length, 2)
		assert.notEqual(forwarded[0]?.bridgeToken, forwarded[1]?.bridgeToken)
		emitMessage({ id: 'reused', bridgeToken: forwarded[0]?.bridgeToken, success: true })
		assert.equal(replies.length, 1)
		emitMessage({ id: 'reused', bridgeToken: forwarded[1]?.bridgeToken, success: true })
		assert.equal(replies.length, 2)
		host.dispose()
	} finally { restoreGlobals() }
})

test('host ignores untokened and wrong-token replies for a pending ID and delivers only the reply with its assigned token', async () => {
	const { fakeWindow, framePort, emitMessage, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		let bridgeToken: string | undefined
		const sdkReplies: unknown[] = []
		fakeWindow.addEventListener('message', ({ data, source }) => {
			if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== 'transaction') return
			if (source === fakeWindow && 'method' in data && 'bridgeToken' in data && typeof data.bridgeToken === 'string') bridgeToken = data.bridgeToken
			if (source === framePort) sdkReplies.push(data)
		})
		framePort.postMessage({ id: 'transaction', method: 'sendTransactions', params: { txs: [] }, env: { sdkVersion: '9.1.0' } })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.ok(bridgeToken)
		emitMessage({ id: 'transaction', success: true, data: { safeTxHash: '0xspoofed' }, version: '9.1.0' })
		emitMessage({ id: 'transaction', success: true, data: { safeTxHash: '0xstale' }, version: '9.1.0', bridgeToken: `${ bridgeToken }-stale` })
		assert.deepEqual(sdkReplies, [])
		emitMessage({ id: 'transaction', success: true, data: { safeTxHash: '0x01' }, version: '9.1.0', bridgeToken })
		emitMessage({ id: 'transaction', success: true, data: { safeTxHash: '0xreplayed' }, version: '9.1.0', bridgeToken })
		assert.deepEqual(sdkReplies, [{ id: 'transaction', success: true, data: { safeTxHash: '0x01' }, version: '9.1.0' }])
		host.dispose()
	} finally { restoreGlobals() }
})

test('operations awaiting approval outlive the request deadline and still deliver their result, while discovery expires', async () => {
	const { fakeWindow, framePort, emitMessage, activeTimeouts, fireTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const forwardedTokens = new Map<string, string>()
		const cancellations: string[] = []
		const sdkReplies: unknown[] = []
		fakeWindow.addEventListener('message', ({ data, source }) => {
			if (typeof data !== 'object' || data === null || !('id' in data) || typeof data.id !== 'string') return
			if (source === fakeWindow && 'method' in data && 'bridgeToken' in data && typeof data.bridgeToken === 'string') forwardedTokens.set(data.id, data.bridgeToken)
			if (source === fakeWindow && 'type' in data && data.type === 'interceptor_safe_apps_cancel') cancellations.push(data.id)
			if (source === framePort) sdkReplies.push(data)
		})
		framePort.postMessage({ id: 'transaction', method: 'sendTransactions', params: { txs: [] }, env: { sdkVersion: '9.1.0' } })
		framePort.postMessage({ id: 'signature', method: 'signMessage', params: { message: 'hello' }, env: { sdkVersion: '9.1.0' } })
		framePort.postMessage({ id: 'discovery', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual([...forwardedTokens.keys()], ['transaction', 'signature', 'discovery'])
		// Only the discovery request schedules a deadline.
		assert.deepEqual(activeTimeouts(), [5 * 60_000])
		fireTimeouts(5 * 60_000)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(cancellations, ['discovery'])
		assert.deepEqual(sdkReplies, [{ id: 'discovery', success: false, error: 'Safe Apps request timed out.', version: '9.1.0' }])
		emitMessage({ id: 'transaction', success: true, data: { safeTxHash: '0x01' }, version: '9.1.0', bridgeToken: forwardedTokens.get('transaction') })
		emitMessage({ id: 'signature', success: true, data: { safeTxHash: '0x02' }, version: '9.1.0', bridgeToken: forwardedTokens.get('signature') })
		assert.deepEqual(sdkReplies.slice(1), [
			{ id: 'transaction', success: true, data: { safeTxHash: '0x01' }, version: '9.1.0' },
			{ id: 'signature', success: true, data: { safeTxHash: '0x02' }, version: '9.1.0' },
		])
		host.dispose()
	} finally { restoreGlobals() }
})

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
		const forwardedTokens = new Map<string, string>()
		fakeWindow.addEventListener('message', (event) => {
			if (!('data' in event) || !('source' in event)) return
			if (event.source === fakeWindow && typeof event.data === 'object' && event.data !== null && 'id' in event.data && typeof event.data.id === 'string' && 'bridgeToken' in event.data && typeof event.data.bridgeToken === 'string') forwardedTokens.set(event.data.id, event.data.bridgeToken)
			if (event.source === fakeWindow && typeof event.data === 'object' && event.data !== null && 'method' in event.data && event.data.method === 'getSafeInfo' && 'id' in event.data && event.data.id === 'sdk-request') {
				postMessage({ id: 'sdk-request', success: true, data: { safeAddress: '0x123' }, version: '9.1.0', bridgeToken: forwardedTokens.get('sdk-request') }, origin)
			}
			if (event.source === fakeWindow && typeof event.data === 'object' && event.data !== null && 'method' in event.data && event.data.method === 'getChainInfo' && 'id' in event.data && typeof event.data.id === 'string' && event.data.id.startsWith('bulk-')) {
				forwardedBulkRequests.add(event.data.id)
				postMessage({ id: event.data.id, success: true, data: {}, version: '9.1.0', bridgeToken: forwardedTokens.get(event.data.id) }, origin)
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
			postMessage({ id, success: approved, ...(approved ? { data: { safeAddress: '0x123' } } : { error: 'User rejected access.' }), version: '9.1.0', bridgeToken: forwardedTokens.get(id) }, origin)
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

test('host disposal rejects pending SDK requests, cancels provider discovery and permits reinstallation', async () => {
	const { fakeWindow, framePort, emitMessage, emitParentMessage, activeTimeouts, frameWasAppended, restoreGlobals } = createSafeHostHarness()
	const originalParent = Object.getOwnPropertyDescriptor(fakeWindow, 'parent')
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		assert.equal(installSafeAppsHost(), undefined)
		const cancellations: string[] = []
		const sdkReplies: unknown[] = []
		const forwarded: string[] = []
		const forwardedTokens = new Map<string, unknown>()
		fakeWindow.addEventListener('message', (event) => {
			if (!('data' in event) || !('source' in event) || typeof event.data !== 'object' || event.data === null || !('id' in event.data) || typeof event.data.id !== 'string') return
			if (event.source === framePort) sdkReplies.push(event.data)
			if (event.source === fakeWindow && 'method' in event.data) {
				forwarded.push(event.data.id)
				if ('bridgeToken' in event.data) forwardedTokens.set(event.data.id, event.data.bridgeToken)
			}
			if (event.source === fakeWindow && 'type' in event.data && event.data.type === 'interceptor_safe_apps_cancel') cancellations.push(event.data.id)
		})
		emitParentMessage({ id: 'pending', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await Promise.resolve()
		assert.equal(activeTimeouts().length, 1)
		host.dispose()
		host.dispose()
		assert.deepEqual(Object.getOwnPropertyDescriptor(fakeWindow, 'parent'), originalParent)
		assert.equal(frameWasAppended(), false)
		assert.deepEqual(activeTimeouts(), [])
		await Promise.resolve()
		assert.deepEqual(cancellations, ['pending'])
		assert.deepEqual(sdkReplies, [{ id: 'pending', success: false, error: 'Safe Apps hosting was disconnected.', version: '9.1.0' }])
		emitMessage({ id: 'pending', success: true, bridgeToken: forwardedTokens.get('pending') })
		emitParentMessage({ id: 'after-disposal', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await Promise.resolve()
		assert.deepEqual(forwarded, ['pending'])
		assert.equal(sdkReplies.length, 1)
		const replacement = installSafeAppsHost()
		assert.ok(replacement)
		emitParentMessage({ id: 'reinstalled', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } })
		await Promise.resolve()
		emitMessage({ id: 'reinstalled', success: true, bridgeToken: forwardedTokens.get('reinstalled') })
		assert.deepEqual(forwarded, ['pending', 'reinstalled'])
		assert.equal(sdkReplies.length, 2)
		replacement.dispose()
	} finally { restoreGlobals() }
})

test('host disposal restores the original parent and removes its marker even after the page replaced parent', () => {
	const { fakeWindow, frameWasAppended, infoLogs, restoreGlobals } = createSafeHostHarness({ origin: 'https://marked.example' })
	const originalParent = Object.getOwnPropertyDescriptor(fakeWindow, 'parent')
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const marker = Object.getOwnPropertyDescriptor(fakeWindow, SAFE_APPS_HOST_MARKER)
		assert.deepEqual(marker, { value: true, writable: false, enumerable: false, configurable: true })
		assert.deepEqual(infoLogs, ['Interceptor: window.parent is emulated on https://marked.example by The Interceptor\'s Safe Apps hosting (window.__interceptorSafeAppsHostEmulatedParent).'])
		Object.defineProperty(fakeWindow, 'parent', { configurable: true, value: new EventTarget() })
		host.dispose()
		assert.deepEqual(Object.getOwnPropertyDescriptor(fakeWindow, 'parent'), originalParent)
		assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, SAFE_APPS_HOST_MARKER), undefined)
		assert.equal(frameWasAppended(), false)
	} finally { restoreGlobals() }
})

test('host disposal leaves a parent the page made non-configurable in place without throwing', () => {
	const { fakeWindow, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const pageParent = new EventTarget()
		Object.defineProperty(fakeWindow, 'parent', { configurable: false, value: pageParent })
		host.dispose()
		assert.equal(Reflect.get(fakeWindow, 'parent'), pageParent)
		assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, SAFE_APPS_HOST_MARKER), undefined)
	} finally { restoreGlobals() }
})

test('page lifetime hosting disposes on pagehide and hosts again only when the back/forward cache restores the page', () => {
	const { fakeWindow, frameWasAppended, restoreGlobals } = createSafeHostHarness()
	const originalParent = Reflect.get(fakeWindow, 'parent')
	const pageTransition = (type: string, persisted: boolean) => Object.assign(new Event(type), { persisted })
	try {
		hostSafeAppsForPageLifetime()
		assert.notEqual(Reflect.get(fakeWindow, 'parent'), originalParent)
		fakeWindow.dispatchEvent(pageTransition('pagehide', true))
		assert.equal(Reflect.get(fakeWindow, 'parent'), originalParent)
		assert.equal(Reflect.get(fakeWindow, SAFE_APPS_HOST_MARKER), undefined)
		assert.equal(frameWasAppended(), false)
		fakeWindow.dispatchEvent(pageTransition('pageshow', false))
		assert.equal(Reflect.get(fakeWindow, 'parent'), originalParent)
		fakeWindow.dispatchEvent(pageTransition('pageshow', true))
		assert.notEqual(Reflect.get(fakeWindow, 'parent'), originalParent)
		assert.equal(Reflect.get(fakeWindow, SAFE_APPS_HOST_MARKER), true)
		fakeWindow.dispatchEvent(pageTransition('pagehide', false))
		assert.equal(Reflect.get(fakeWindow, 'parent'), originalParent)
	} finally { restoreGlobals() }
})

test('the host re-sources only Safe SDK responses, never unrelated page messages', async () => {
	const { fakeWindow, framePort, emitMessage, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const resourced: unknown[] = []
		fakeWindow.addEventListener('message', (event) => { if ('source' in event && event.source === framePort && 'data' in event) resourced.push(event.data) })
		for (const data of [{ hello: 'analytics' }, 'plain text', { id: 'not-pending', success: true }, { type: 'some-widget', id: 'x' }]) emitMessage(data)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(resourced, [])
		host.dispose()
	} finally { restoreGlobals() }
})

test('host installation removes its frame when parent replacement fails', () => {
	const { fakeWindow, frameWasAppended, activeTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		Object.defineProperty(fakeWindow, 'parent', { configurable: false, value: fakeWindow })
		assert.throws(() => installSafeAppsHost(), TypeError)
		assert.equal(frameWasAppended(), false)
		assert.deepEqual(activeTimeouts(), [])
	} finally { restoreGlobals() }
})


test('host disposal rejects a real SDK request while its emulated parent is still installed', async () => {
	const { fakeWindow, activeTimeouts, restoreGlobals } = createSafeHostHarness()
	try {
		const host = installSafeAppsHost()
		assert.ok(host)
		const sdk = new SafeAppsSDK()
		const rejected = assert.rejects(sdk.safe.getInfo(), /Safe Apps hosting was disconnected/)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(activeTimeouts().length, 1)
		host.dispose()
		await rejected
		assert.equal(Reflect.get(fakeWindow, 'parent'), fakeWindow)
		assert.deepEqual(activeTimeouts(), [])
	} finally { restoreGlobals() }
})

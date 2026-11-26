import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { observeNativeGnosisSafeAppsSource } from '../../app/ts/background/nativeGnosisSafeAppsSourceLifecycle.js'

function sourceEvents() {
	const removed = new Set<(tabId: number) => void>()
	const updated = new Set<(tabId: number, change: { readonly url?: string }) => void>()
	return {
		removed, updated,
		events: {
			onRemoved: { addListener: (listener: (tabId: number) => void) => { removed.add(listener) }, removeListener: (listener: (tabId: number) => void) => { removed.delete(listener) } },
			onUpdated: { addListener: (listener: (tabId: number, change: { readonly url?: string }) => void) => { updated.add(listener) }, removeListener: (listener: (tabId: number, change: { readonly url?: string }) => void) => { updated.delete(listener) } },
		},
		remove: (tabId: number) => { for (const listener of removed) listener(tabId) },
		update: (tabId: number, url?: string) => { for (const listener of updated) listener(tabId, { url }) },
	}
}

test('source tab removal and cross-origin navigation disconnect once without depending on storage changes', () => {
	for (const action of ['close', 'cross-origin', 'scheme', 'port', 'non-http']) {
		const events = sourceEvents()
		let disconnections = 0
		const stop = observeNativeGnosisSafeAppsSource(10, 'https://app.example', () => { disconnections++ }, events.events)
		if (action === 'close') events.remove(10)
		if (action === 'cross-origin') events.update(10, 'https://another.example/swap')
		if (action === 'scheme') events.update(10, 'http://app.example/swap')
		if (action === 'port') events.update(10, 'https://app.example:8443/swap')
		if (action === 'non-http') events.update(10, 'about:blank')
		assert.equal(disconnections, 1, action)
		events.remove(10)
		events.update(10, 'https://another.example/')
		assert.equal(disconnections, 1, 'repeated source events do not invalidate the session again')
		stop()
	}
})

test('same-origin path changes, updates without URLs and unrelated tabs preserve the source session', () => {
	const events = sourceEvents()
	let disconnections = 0
	const stop = observeNativeGnosisSafeAppsSource(10, 'https://app.example', () => { disconnections++ }, events.events)
	events.update(10, 'https://app.example/another-path?query=1#hash')
	events.update(10)
	events.update(20, 'https://another.example/')
	events.remove(20)
	assert.equal(disconnections, 0)
	stop()
})

test('source lifecycle cleanup removes both listeners and ignores already queued events', () => {
	const events = sourceEvents()
	let disconnections = 0
	const stop = observeNativeGnosisSafeAppsSource(10, 'https://app.example', () => { disconnections++ }, events.events)
	const queuedRemoval = [...events.removed][0]
	const queuedUpdate = [...events.updated][0]
	assert.equal(events.removed.size, 1)
	assert.equal(events.updated.size, 1)
	stop()
	assert.equal(events.removed.size, 0)
	assert.equal(events.updated.size, 0)
	queuedRemoval?.(10)
	queuedUpdate?.(10, { url: 'https://another.example/' })
	assert.equal(disconnections, 0)
})

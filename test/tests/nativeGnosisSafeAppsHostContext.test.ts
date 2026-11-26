import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { attachNativeGnosisSafeAppsHostContext } from '../../app/ts/background/nativeGnosisSafeAppsHostContext.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT } from '../../app/ts/types/nativeGnosisSafeAppsHostContext.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'

function setup() {
	installBrowserMock({ manifestVersion: 3 })
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (file: string) => new URL(file, 'chrome-extension://extension-id/').href })
	const changed = new Set<(changes: Record<string, browser.storage.StorageChange>, area: string) => void>()
	const removed = new Set<(id: number) => void>()
	const updated = new Set<(id: number, change: { url?: string }) => void>()
	Object.assign(browser.storage, { onChanged: { addListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { changed.add(listener) }, removeListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { changed.delete(listener) } } })
	Object.assign(browser.tabs, {
		get: async () => ({ id: 12, url: 'https://app.example/path' }),
		onRemoved: { addListener: (listener: (id: number) => void) => { removed.add(listener) }, removeListener: (listener: (id: number) => void) => { removed.delete(listener) } },
		onUpdated: { addListener: (listener: (id: number, change: { url?: string }) => void) => { updated.add(listener) }, removeListener: (listener: (id: number, change: { url?: string }) => void) => { updated.delete(listener) } },
	})
	const notifications: unknown[] = []
	const disconnected = new Set<() => void>()
	let disconnects = 0
	const port = {
		name: NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT,
		sender: { id: 'extension-id', url: 'chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html?sourceTabId=12&appUrl=https%3A%2F%2Fapp.example%2Fswap' },
		postMessage: (message: unknown) => { notifications.push(JSON.parse(JSON.stringify(message))) },
		disconnect: () => { disconnects++ },
		onDisconnect: { addListener: (listener: () => void) => { disconnected.add(listener) } },
	}
	return { port, notifications, changed, removed, updated, disconnected, get disconnects() { return disconnects } }
}

test('background publishes permission context changes and scoped source lifecycle without UI storage/tab observers', async () => {
	const state = setup()
	assert.equal(attachNativeGnosisSafeAppsHostContext(state.port), true)
	await Promise.resolve()
	for (const change of state.changed) change({ simulationMode: { newValue: false } }, 'local')
	for (const removed of state.removed) removed(99)
	assert.deepEqual(state.notifications, [{ type: 'context-changed', keys: ['simulationMode'] }])
	for (const updated of state.updated) updated(12, { url: 'https://other.example/' })
	assert.deepEqual(state.notifications.at(-1), { type: 'source-disconnected' })
	for (const disconnected of state.disconnected) disconnected()
	assert.equal(state.changed.size + state.removed.size + state.updated.size, 0)
})

test('background rejects wrong-page or malformed host subscriptions before observing source state', () => {
	for (const url of ['https://app.example/', 'chrome-extension://extension-id/html/settingsView.html', 'chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html?sourceTabId=invalid']) {
		const state = setup()
		assert.equal(attachNativeGnosisSafeAppsHostContext({ ...state.port, sender: { ...state.port.sender, url } }), true)
		assert.equal(state.disconnects, 1)
		assert.equal(state.changed.size + state.removed.size + state.updated.size, 0)
	}
	const state = setup()
	assert.equal(attachNativeGnosisSafeAppsHostContext({ ...state.port, name: 'website-provider' }), false)
})


test('host presentation consumes background context messages instead of storage or tab lifecycle', async () => {
	const component = await Bun.file(new URL('../../app/ts/components/pages/NativeGnosisSafeAppsHost.tsx', import.meta.url)).text()
	const controller = await Bun.file(new URL('../../app/ts/components/pages/nativeGnosisSafeAppsHostController.ts', import.meta.url)).text()
	assert.doesNotMatch(component, /browser\.storage|browser\.tabs\.on(?:Updated|Removed)/u)
	assert.doesNotMatch(controller, /StorageChange|contentScriptSettings|nativeGnosisSafeAppsStorageChangeAffectsContext/u)
	const popupReplies = await Bun.file(new URL('../../app/ts/types/interceptor-reply-messages.ts', import.meta.url)).text()
	assert.doesNotMatch(popupReplies, /gnosisSafeAppsProtocol|utils\/nativeGnosisSafeAppsHost/u)
})


test('subscription catches an already-closed source and does not publish a late initial read after cleanup', async () => {
	const state = setup()
	const read = Promise.withResolvers<browser.tabs.Tab>()
	Object.assign(browser.tabs, { get: async () => await read.promise })
	attachNativeGnosisSafeAppsHostContext(state.port)
	for (const disconnected of state.disconnected) disconnected()
	read.resolve({ id: 12, active: false, highlighted: false, incognito: false, index: 0, pinned: false, selected: false, windowId: 1, url: 'https://other.example/' })
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.deepEqual(state.notifications, [])
	const closed = setup()
	Object.assign(browser.tabs, { get: async () => { throw new Error('No tab with id: 12.') } })
	attachNativeGnosisSafeAppsHostContext(closed.port)
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.deepEqual(closed.notifications, [{ type: 'source-disconnected' }])
})

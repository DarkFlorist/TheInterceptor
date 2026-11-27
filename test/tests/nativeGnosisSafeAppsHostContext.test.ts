import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { attachNativeGnosisSafeAppsHostContext } from '../../app/ts/background/nativeGnosisSafeAppsHostContext.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT } from '../../app/ts/types/nativeGnosisSafeAppsHostContext.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'

function setup() {
	installBrowserMock({ manifestVersion: 3 })
	Object.assign(browser.runtime, { id: 'extension-id', getURL: (file: string) => new URL(file, 'chrome-extension://extension-id/').href })
	const changed = new Set<(changes: Record<string, browser.storage.StorageChange>, area: string) => void>()
	Object.assign(browser.storage, { onChanged: { addListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { changed.add(listener) }, removeListener: (listener: (changes: Record<string, browser.storage.StorageChange>, area: string) => void) => { changed.delete(listener) } } })
	Object.assign(browser.tabs, {
		get: async () => { throw new Error('Host context must not look up an original website tab') },
		onRemoved: { addListener: () => { throw new Error('Host context must not observe unrelated tab removals') } },
		onUpdated: { addListener: () => { throw new Error('Host context must not observe unrelated tab navigation') } },
	})
	const notifications: unknown[] = []
	const disconnected = new Set<() => void>()
	let disconnects = 0
	const port = {
		name: NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT,
		sender: { id: 'extension-id', tab: { id: 12 }, frameId: 0, url: 'chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html?hostTabId=12&appUrl=https%3A%2F%2Fapp.example%2Fswap' },
		postMessage: (message: unknown) => { notifications.push(JSON.parse(JSON.stringify(message))) },
		disconnect: () => { disconnects++ },
		onDisconnect: { addListener: (listener: () => void) => { disconnected.add(listener) } },
	}
	return { port, notifications, changed, disconnected, get disconnects() { return disconnects } }
}

test('background publishes permission context changes without observing any original website tab', () => {
	const state = setup()
	assert.equal(attachNativeGnosisSafeAppsHostContext(state.port), true)
	assert.equal(state.disconnects, 0)
	for (const change of state.changed) change({ simulationMode: { newValue: false } }, 'sync')
	assert.deepEqual(state.notifications, [])
	for (const change of state.changed) change({ simulationMode: { newValue: false } }, 'local')
	assert.deepEqual(state.notifications, [{ type: 'context-changed', keys: ['simulationMode'] }])
	for (const disconnected of state.disconnected) disconnected()
	assert.equal(state.changed.size, 0)
})

test('background rejects wrong-page, malformed and wrong-tab host subscriptions before observing settings', () => {
	for (const url of ['https://app.example/', 'chrome-extension://extension-id/html/settingsView.html', 'chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html?hostTabId=invalid', 'chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html?hostTabId=99&appUrl=https%3A%2F%2Fapp.example%2Fswap']) {
		const state = setup()
		assert.equal(attachNativeGnosisSafeAppsHostContext({ ...state.port, sender: { ...state.port.sender, url } }), true)
		assert.equal(state.disconnects, 1)
		assert.equal(state.changed.size, 0)
	}
	for (const sender of [{ id: 'other-extension', tab: { id: 12 }, url: setup().port.sender.url }, { id: 'extension-id', url: setup().port.sender.url }]) {
		const state = setup()
		assert.equal(attachNativeGnosisSafeAppsHostContext({ ...state.port, sender }), true)
		assert.equal(state.disconnects, 1)
		assert.equal(state.changed.size, 0)
	}
	const state = setup()
	assert.equal(attachNativeGnosisSafeAppsHostContext({ ...state.port, name: 'website-provider' }), false)
})

test('disconnected context ports cannot publish late settings notifications', () => {
	const state = setup()
	attachNativeGnosisSafeAppsHostContext(state.port)
	const listener = [...state.changed][0]
	assert.ok(listener)
	for (const disconnected of state.disconnected) disconnected()
	listener({ simulationMode: { newValue: false } }, 'local')
	assert.deepEqual(state.notifications, [])
})

test('host presentation consumes background context messages instead of observing storage or tab lifecycle', async () => {
	const component = await Bun.file(new URL('../../app/ts/components/pages/NativeGnosisSafeAppsHost.tsx', import.meta.url)).text()
	const controller = await Bun.file(new URL('../../app/ts/components/pages/nativeGnosisSafeAppsHostController.ts', import.meta.url)).text()
	assert.doesNotMatch(component, /browser\.storage|browser\.tabs\.on(?:Updated|Removed)/u)
	assert.doesNotMatch(controller, /StorageChange|contentScriptSettings|nativeGnosisSafeAppsStorageChangeAffectsContext/u)
	const popupReplies = await Bun.file(new URL('../../app/ts/types/interceptor-reply-messages.ts', import.meta.url)).text()
	assert.doesNotMatch(popupReplies, /gnosisSafeAppsProtocol|utils\/nativeGnosisSafeAppsHost/u)
})

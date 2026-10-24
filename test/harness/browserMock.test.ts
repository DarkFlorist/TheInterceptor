import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { requireDefined } from './assertions.js'
import { flushMicrotasks } from './async.js'
import { createBrowserMock, createMockEvent, createMockPort, createMockPortPair, installBrowserMock, type StorageAreaName, type StorageChanges } from './browserMock.js'

describe('browser mock storage', () => {
	test('get omits missing keys for every key form', async () => {
		const { browser } = createBrowserMock({ storage: { local: { present: 1, other: 'two' } } })

		assert.deepEqual(await browser.storage.local.get('missing'), {})
		assert.deepEqual(await browser.storage.local.get('present'), { present: 1 })
		assert.deepEqual(await browser.storage.local.get(['present', 'missing']), { present: 1 })
		assert.deepEqual(await browser.storage.local.get([]), {})
		assert.deepEqual(await browser.storage.local.get(null), { present: 1, other: 'two' })
		assert.deepEqual(await browser.storage.local.get(), { present: 1, other: 'two' })
		assert.equal(Object.hasOwn(await browser.storage.local.get(['missing']), 'missing'), false)
	})

	test('get applies object defaults only to missing keys', async () => {
		const { browser } = createBrowserMock({ storage: { local: { present: 1 } } })

		assert.deepEqual(await browser.storage.local.get({ present: 0, missing: 'default', missingWithoutDefault: undefined }), { present: 1, missing: 'default' })
	})

	test('stores and returns copies like structured-clone storage', async () => {
		const { browser } = createBrowserMock()
		const stored = { nested: { value: 1n } }
		await browser.storage.local.set({ stored })
		stored.nested.value = 2n

		const firstRead = await browser.storage.local.get('stored')
		assert.deepEqual(firstRead, { stored: { nested: { value: 1n } } })
		Reflect.set(firstRead, 'stored', 'mutated by the caller')
		assert.deepEqual(await browser.storage.local.get('stored'), { stored: { nested: { value: 1n } } })
	})

	test('remove and clear delete items', async () => {
		const browserMock = createBrowserMock({ storage: { local: { first: 1, second: 2, third: 3 } } })
		await browserMock.browser.storage.local.remove('first')
		await browserMock.browser.storage.local.remove(['second', 'missing'])
		assert.deepEqual(browserMock.readStorage(), { third: 3 })

		await browserMock.browser.storage.local.clear()
		assert.deepEqual(browserMock.readStorage(), {})
	})

	test('fires area and global change events with real oldValue and newValue shapes', async () => {
		const browserMock = createBrowserMock({ storage: { local: { existing: 'old' } } })
		const globalChanges: { changes: StorageChanges, areaName: StorageAreaName }[] = []
		const localChanges: StorageChanges[] = []
		browserMock.browser.storage.onChanged.addListener((changes, areaName) => { globalChanges.push({ changes, areaName }) })
		browserMock.browser.storage.local.onChanged.addListener((changes) => { localChanges.push(changes) })

		await browserMock.browser.storage.local.set({ existing: 'new', added: 1 })
		await browserMock.browser.storage.local.remove(['existing', 'missing'])
		await browserMock.browser.storage.local.remove('missing')
		await browserMock.browser.storage.session.set({ sessionOnly: true })

		assert.deepEqual(localChanges, [
			{ existing: { oldValue: 'old', newValue: 'new' }, added: { newValue: 1 } },
			{ existing: { oldValue: 'new' } },
		])
		assert.deepEqual(globalChanges, [
			{ changes: { existing: { oldValue: 'old', newValue: 'new' }, added: { newValue: 1 } }, areaName: 'local' },
			{ changes: { existing: { oldValue: 'new' } }, areaName: 'local' },
			{ changes: { sessionOnly: { newValue: true } }, areaName: 'session' },
		])
		assert.deepEqual(browserMock.readStorage('session'), { sessionOnly: true })
	})

	test('API methods can be replaced to inject failures', async () => {
		const { browser } = createBrowserMock()
		browser.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded') }

		await assert.rejects(browser.storage.local.set({ large: 'value' }), /QUOTA_BYTES/)
	})
})

describe('browser mock runtime', () => {
	test('records sent messages and answers with the configured handler', async () => {
		const browserMock = createBrowserMock({ handlers: { runtimeMessage: async (message) => ({ echoed: message }) } })

		assert.deepEqual(await browserMock.browser.runtime.sendMessage({ method: 'popup_ping' }), { echoed: { method: 'popup_ping' } })
		browserMock.handlers.runtimeMessage = () => undefined
		assert.equal(await browserMock.browser.runtime.sendMessage('second'), undefined)
		assert.deepEqual(browserMock.calls.runtimeSendMessage, [{ method: 'popup_ping' }, 'second'])
	})

	test('dispatchRuntimeMessage follows promise, sendResponse and no-answer listener semantics', async () => {
		const browserMock = createBrowserMock()
		assert.equal(await browserMock.dispatchRuntimeMessage('nobody listens'), undefined)

		const ignoringListener = () => undefined
		browserMock.browser.runtime.onMessage.addListener(ignoringListener)
		assert.equal(await browserMock.dispatchRuntimeMessage('ignored'), undefined)

		const promiseListener = async (message: unknown) => `promise:${ String(message) }`
		browserMock.browser.runtime.onMessage.addListener(promiseListener)
		assert.equal(await browserMock.dispatchRuntimeMessage('first'), 'promise:first')
		browserMock.browser.runtime.onMessage.removeListener(promiseListener)

		browserMock.browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
			setTimeout(() => { sendResponse(`callback:${ String(message) }`) }, 1)
			return true
		})
		assert.equal(await browserMock.dispatchRuntimeMessage('second'), 'callback:second')
	})

	test('exposes the manifest version, extension URLs and a settable lastError', () => {
		const { browser } = createBrowserMock({ manifestVersion: 2, extensionId: 'extension-id' })

		assert.deepEqual(browser.runtime.getManifest(), { manifest_version: 2 })
		assert.equal(browser.runtime.getURL('/html/popup.html'), 'chrome-extension://extension-id/html/popup.html')
		assert.equal(browser.runtime.lastError, undefined)
		browser.runtime.lastError = { message: 'The message port closed before a response was received.' }
		assert.equal(browser.runtime.lastError.message, 'The message port closed before a response was received.')
	})

	test('connect hands the other end to onConnect listeners and links both ends', async () => {
		const browserMock = createBrowserMock()
		const backgroundMessages: unknown[] = []
		browserMock.browser.runtime.onConnect.addListener((port) => {
			port.onMessage.addListener((message) => { backgroundMessages.push(message) })
			port.postMessage({ type: 'welcome' })
		})
		const contentScriptMessages: unknown[] = []
		const contentScriptPort = browserMock.browser.runtime.connect({ name: 'content-script' })
		contentScriptPort.onMessage.addListener((message) => { contentScriptMessages.push(message) })
		let disconnected = false
		const [connection] = browserMock.connections
		connection?.receiver.port.onDisconnect.addListener(() => { disconnected = true })

		await flushMicrotasks()
		contentScriptPort.postMessage({ type: 'hello' })
		await flushMicrotasks()
		contentScriptPort.disconnect()
		await flushMicrotasks()

		assert.equal(connection?.receiver.port.name, 'content-script')
		assert.deepEqual(backgroundMessages, [{ type: 'hello' }])
		assert.deepEqual(contentScriptMessages, [{ type: 'welcome' }])
		assert.equal(disconnected, true)
		assert.throws(() => { contentScriptPort.postMessage('late') }, /Attempting to use a disconnected port object/)
	})
})

describe('browser mock ports', () => {
	test('a recording port keeps posted messages and simulates the other end', () => {
		const mockPort = createMockPort({ name: '0x1', sender: { tab: { id: 7, index: 0, highlighted: false, active: true, pinned: false, incognito: false } } })
		const received: unknown[] = []
		const disconnectedPorts: browser.runtime.Port[] = []
		mockPort.port.onMessage.addListener((message) => { received.push(message) })
		mockPort.port.onDisconnect.addListener((port) => { disconnectedPorts.push(port) })

		mockPort.port.postMessage({ method: 'eth_chainId' })
		mockPort.receiveMessage({ result: '0x1' })
		mockPort.disconnectFromOtherEnd()

		assert.equal(mockPort.port.sender?.tab?.id, 7)
		assert.deepEqual(mockPort.postedMessages, [{ method: 'eth_chainId' }])
		assert.deepEqual(received, [{ result: '0x1' }])
		assert.deepEqual(disconnectedPorts, [mockPort.port])
		assert.equal(mockPort.isDisconnected(), true)
	})

	test('a port pair delivers messages and disconnects asynchronously', async () => {
		const { connector, receiver } = createMockPortPair({ name: 'pair' })
		const received: unknown[] = []
		receiver.port.onMessage.addListener((message) => { received.push(message) })

		connector.port.postMessage('ping')
		assert.deepEqual(received, [])
		await flushMicrotasks()
		assert.deepEqual(received, ['ping'])

		receiver.port.disconnect()
		await flushMicrotasks()
		assert.equal(connector.isDisconnected(), true)
	})

	test('events ignore duplicate listeners and report registrations', () => {
		const event = createMockEvent<[value: number], number>()
		const double = (value: number) => value * 2
		event.addListener(double)
		event.addListener(double)

		assert.equal(event.hasListener(double), true)
		assert.deepEqual(event.dispatch(4), [8])
		event.removeListener(double)
		assert.equal(event.hasListeners(), false)
	})
})

describe('browser mock tabs and windows', () => {
	test('tabs keep state, record calls and reject unknown ids like Chrome', async () => {
		const browserMock = createBrowserMock({ tabs: [{ id: 3, url: 'https://first.test', active: true }, { id: 4, url: 'https://second.test' }] })
		const removedTabIds: number[] = []
		browserMock.browser.tabs.onRemoved.addListener((tabId) => { removedTabIds.push(tabId) })

		assert.deepEqual((await browserMock.browser.tabs.query({ active: true })).map((tab) => tab.id), [3])
		await browserMock.browser.tabs.update(4, { active: true, url: 'https://updated.test' })
		assert.deepEqual((await browserMock.browser.tabs.query({ active: true })).map((tab) => tab.id), [4])
		const createdTab = await browserMock.browser.tabs.create({ url: 'https://created.test', active: false })
		await browserMock.browser.tabs.remove(3)

		assert.equal(createdTab.id, 5)
		assert.equal(browserMock.getTab(4)?.url, 'https://updated.test')
		assert.equal(browserMock.getTab(3), undefined)
		assert.deepEqual(removedTabIds, [3])
		assert.deepEqual(browserMock.calls.tabsRemove, [3])
		assert.deepEqual(browserMock.calls.tabsUpdate, [{ tabId: 4, updateProperties: { active: true, url: 'https://updated.test' } }])
		await assert.rejects(browserMock.browser.tabs.get(99), /^Error: No tab with id: 99\.$/)
		await assert.rejects(browserMock.browser.tabs.update(99, { active: true }), /No tab with id: 99\./)
	})

	test('tabs.sendMessage rejects without a receiver until a handler answers', async () => {
		const browserMock = createBrowserMock({ tabs: [{ id: 1 }] })
		await assert.rejects(browserMock.browser.tabs.sendMessage(1, { ping: true }), /Could not establish connection\. Receiving end does not exist\./)

		browserMock.handlers.tabMessage = async (tabId) => ({ pong: tabId })
		assert.deepEqual(await browserMock.browser.tabs.sendMessage(1, { ping: true }), { pong: 1 })
		assert.deepEqual(browserMock.calls.tabsSendMessage, [{ tabId: 1, message: { ping: true } }, { tabId: 1, message: { ping: true } }])
	})

	test('windows open with tabs, change focus and close with their tabs', async () => {
		const browserMock = createBrowserMock()
		const removedWindowIds: number[] = []
		browserMock.browser.windows.onRemoved.addListener((windowId) => { removedWindowIds.push(windowId) })

		const popup = await browserMock.browser.windows.create({ url: 'popup.html', type: 'popup' })
		assert.equal(popup.id, 2)
		assert.equal((await browserMock.browser.windows.getCurrent()).id, 2)
		await browserMock.browser.windows.update(1, { focused: true })
		assert.equal((await browserMock.browser.windows.getCurrent()).id, 1)
		assert.deepEqual((await browserMock.browser.tabs.query({ windowId: 2 })).map((tab) => tab.url), ['popup.html'])

		await browserMock.browser.windows.remove(2)

		assert.deepEqual(removedWindowIds, [2])
		assert.deepEqual(await browserMock.browser.tabs.query({ windowId: 2 }), [])
		await assert.rejects(browserMock.browser.windows.get(2), /No window with id: 2\./)
	})

	test('created ids are never reused after the newest tab or window is removed', async () => {
		const browserMock = createBrowserMock({ tabs: [{ id: 1 }] })

		const firstTab = await browserMock.browser.tabs.create({ url: 'https://first.test' })
		await browserMock.browser.tabs.remove(requireDefined(firstTab.id, 'created tab id'))
		const secondTab = await browserMock.browser.tabs.create({ url: 'https://second.test' })
		const firstPopup = await browserMock.browser.windows.create({ url: 'popup.html', type: 'popup' })
		await browserMock.browser.windows.remove(requireDefined(firstPopup.id, 'created window id'))
		const secondPopup = await browserMock.browser.windows.create({ url: 'popup.html', type: 'popup' })

		assert.equal(firstTab.id, 2)
		assert.equal(secondTab.id, 3)
		assert.equal(firstPopup.id, 2)
		assert.equal(secondPopup.id, 3)
	})

	test('a window opened with several URLs takes one fresh id per tab', async () => {
		const browserMock = createBrowserMock()

		const firstWindow = await browserMock.browser.windows.create({ url: ['https://first.test', 'https://second.test'] })
		const laterTab = await browserMock.browser.tabs.create({ url: 'https://later.test' })
		const secondWindow = await browserMock.browser.windows.create({ url: 'https://third.test' })

		const tabIds = [...firstWindow.tabs.map((tab) => tab.id), laterTab.id, ...secondWindow.tabs.map((tab) => tab.id)]
		assert.deepEqual(tabIds, [1, 2, 3, 4])
		assert.equal(browserMock.getTab(2)?.url, 'https://second.test')
		assert.equal(browserMock.getTab(3)?.url, 'https://later.test')
	})

	test('tabs.query with lastFocusedWindow or currentWindow only matches tabs of the focused window', async () => {
		const browserMock = createBrowserMock({
			windows: [{ id: 1, focused: false }, { id: 2, focused: true }],
			tabs: [{ id: 10, windowId: 1, active: true }, { id: 20, windowId: 2, active: true }],
		})

		assert.deepEqual((await browserMock.browser.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id), [20])
		assert.deepEqual((await browserMock.browser.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.id), [20])
		assert.deepEqual((await browserMock.browser.tabs.query({ active: true, lastFocusedWindow: false })).map((tab) => tab.id), [10])
	})

	test('firstCreatedIds starts created tab and window ids at a fresh range', async () => {
		const browserMock = createBrowserMock({ tabs: [{ id: 1 }], firstCreatedIds: { tab: 500, window: 700 } })

		assert.equal((await browserMock.browser.tabs.create({ url: 'https://created.test' })).id, 500)
		const popup = await browserMock.browser.windows.create({ url: 'popup.html', type: 'popup' })
		assert.equal(popup.id, 700)
		assert.deepEqual(popup.tabs.map((tab) => tab.id), [501])
		assert.equal((await browserMock.browser.tabs.get(1)).id, 1)
	})
})

describe('browser mock extension APIs', () => {
	test('action and browserAction calls are recorded and invoke Chrome callbacks', async () => {
		const browserMock = createBrowserMock()
		let callbackCalls = 0

		await browserMock.browser.action.setIcon({ path: { 128: 'img/head.png' } }, () => { callbackCalls += 1 })
		await browserMock.browser.action.setBadgeText({ text: '!' })
		await browserMock.browser.browserAction.setBadgeBackgroundColor({ color: '#ff0000' })
		await browserMock.browser.browserAction.setTitle({ title: 'The Interceptor' })

		assert.equal(callbackCalls, 1)
		assert.deepEqual(browserMock.calls.action, [
			{ api: 'action', method: 'setIcon', details: { path: { 128: 'img/head.png' } } },
			{ api: 'action', method: 'setBadgeText', details: { text: '!' } },
			{ api: 'browserAction', method: 'setBadgeBackgroundColor', details: { color: '#ff0000' } },
			{ api: 'browserAction', method: 'setTitle', details: { title: 'The Interceptor' } },
		])
	})

	test('declarativeNetRequest keeps dynamic and session rules separately', async () => {
		const { browser, calls } = createBrowserMock()
		const rule = { id: 1, action: { type: 'block' as const }, condition: { urlFilter: 'example.test' } }

		await browser.declarativeNetRequest.updateDynamicRules({ addRules: [rule] })
		await assert.rejects(browser.declarativeNetRequest.updateDynamicRules({ addRules: [rule] }), /does not have a unique ID/)
		await browser.declarativeNetRequest.updateSessionRules({ addRules: [{ ...rule, id: 2 }] })
		await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] })

		assert.deepEqual(await browser.declarativeNetRequest.getDynamicRules(), [])
		assert.deepEqual((await browser.declarativeNetRequest.getSessionRules()).map((sessionRule) => sessionRule.id), [2])
		assert.deepEqual(calls.declarativeNetRequestUpdates.map((update) => update.scope), ['dynamic', 'dynamic', 'session', 'dynamic'])
	})

	test('scripting keeps registered content scripts', async () => {
		const browserMock = createBrowserMock()
		const { scripting } = browserMock.browser

		await scripting.registerContentScripts([{ id: 'inpage', js: ['/inpage/js/inpage.js'], matches: ['<all_urls>'] }])
		await assert.rejects(scripting.registerContentScripts([{ id: 'inpage' }]), /Duplicate script ID 'inpage'/)
		await scripting.updateContentScripts([{ id: 'inpage', allFrames: true }])
		assert.deepEqual(await scripting.getRegisteredContentScripts({ ids: ['inpage'] }), [{ id: 'inpage', js: ['/inpage/js/inpage.js'], matches: ['<all_urls>'], allFrames: true }])
		await scripting.unregisterContentScripts()

		assert.deepEqual(browserMock.getRegisteredContentScripts(), [])
	})
})

describe('installBrowserMock', () => {
	const previousBrowser = Reflect.getOwnPropertyDescriptor(globalThis, 'browser')
	afterEach(() => {
		assert.deepEqual(Reflect.getOwnPropertyDescriptor(globalThis, 'browser'), previousBrowser)
	})

	test('installs browser and chrome globals until restore', async () => {
		const browserMock = installBrowserMock({ extensionId: 'installed-extension', storage: { local: { simulationMode: true } } })
		try {
			assert.deepEqual(await browser.storage.local.get('simulationMode'), { simulationMode: true })
			assert.deepEqual(Reflect.get(globalThis, 'chrome'), { runtime: { id: 'installed-extension' } })
		} finally {
			browserMock.restore()
		}
		assert.equal(Reflect.has(globalThis, 'chrome'), false)
	})

	test('can leave chrome untouched', () => {
		const browserMock = installBrowserMock({ installChrome: false })
		try {
			assert.equal(Reflect.has(globalThis, 'chrome'), false)
		} finally {
			browserMock.restore()
		}
	})
})

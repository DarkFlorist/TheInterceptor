import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getManagementHashForOpenRequest, getSimulationStackManagementHash, getSimulationStackTargetHash, type ManagementOpenRequest } from '../../app/ts/utils/managementPages.js'

type TabRecord = {
	readonly id: number
	readonly url?: string
	readonly windowId?: number
}

type TabCreateDetails = {
	readonly url: string
}

type TabUpdateDetails = {
	readonly tabId: number
	readonly update: {
		readonly active?: boolean
		readonly highlighted?: boolean
		readonly url?: string
	}
}

type WindowUpdateDetails = {
	readonly windowId: number
	readonly update: {
		readonly focused?: boolean
	}
}

type OpenedTabIds = {
	managementTabId?: number | undefined
	settingsView?: number | undefined
	addressBook?: number | undefined
	websiteAccess?: number | undefined
	simulationStack?: number | undefined
}

type StorageState = {
	idsOfOpenedTabs?: OpenedTabIds
	currentTabId?: number
}

function installBrowserMock(tabs: readonly TabRecord[], openedTabs: OpenedTabIds | undefined, updateShouldFail = false, currentTabId?: number) {
	const createdTabs: TabCreateDetails[] = []
	const updatedTabs: TabUpdateDetails[] = []
	const updatedWindows: WindowUpdateDetails[] = []
	const storageState: StorageState = { idsOfOpenedTabs: openedTabs, currentTabId }
	const getStorageValue = (key: string) => key === 'idsOfOpenedTabs' ? storageState.idsOfOpenedTabs : key === 'currentTabId' ? storageState.currentTabId : undefined
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
			},
			storage: {
				local: {
					async get(keys?: string | string[]) {
						const requestedKeys = Array.isArray(keys) ? keys : keys === undefined ? Object.keys(storageState) : [keys]
						return Object.fromEntries(requestedKeys.map((key) => [key, getStorageValue(key)]))
					},
					async set(items: StorageState) {
						Object.assign(storageState, items)
					},
				},
			},
			tabs: {
				async query() {
					return [...tabs]
				},
				async create(details: TabCreateDetails) {
					createdTabs.push(details)
					return { id: 99, ...details }
				},
				async update(tabId: number, update: TabUpdateDetails['update']) {
					if (updateShouldFail) return undefined
					updatedTabs.push({ tabId, update })
					return tabs.find((tab) => tab.id === tabId)
				},
			},
			windows: {
				async update(windowId: number, update: WindowUpdateDetails['update']) {
					updatedWindows.push({ windowId, update })
					return { id: windowId }
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return { createdTabs, updatedTabs, updatedWindows, storageState }
}

async function loadOpenManagementTab() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).openManagementTab
}

async function loadGetLastKnownCurrentTabId() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).getLastKnownCurrentTabId
}

const emptyOpenedTabs = (): OpenedTabIds => ({})

describe('open management tab', () => {
	test('reuses the tracked management tab for its entry point and legacy popup controls', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock(
			[{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites' }],
			{ ...emptyOpenedTabs(), settingsView: 42 },
		)
		const openManagementTab = await loadOpenManagementTab()
		const requests: readonly ManagementOpenRequest[] = ['popup_openManagement', 'popup_openWebsiteAccess', 'popup_openAddressBook', 'popup_openSettings']

		for (const request of requests) {
			await openManagementTab(getManagementHashForOpenRequest(request))
		}
		await openManagementTab(getSimulationStackManagementHash())

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#home' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#websites' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#address-book' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#settings' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#simulation-stack' } },
		])
	})
})

describe('management tab tracking', () => {
	test('prefers the current management tab ID over a legacy settings tab ID', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock(
			[
				{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#settings' },
				{ id: 43, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#home' },
			],
			{ settingsView: 42, managementTabId: 43 },
		)
		const openManagementTab = await loadOpenManagementTab()

		await openManagementTab('#diagnostics')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 43, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#diagnostics' } }])
	})

	test('opens and tracks one management tab even when legacy page IDs were stored', async () => {
		const legacyIds = { ...emptyOpenedTabs(), addressBook: 8, websiteAccess: 9, simulationStack: 10 }
		const { createdTabs, storageState } = installBrowserMock([], legacyIds)
		const openManagementTab = await loadOpenManagementTab()

		await openManagementTab('#diagnostics')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#diagnostics' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('reuses and focuses the tracked management tab window', async () => {
		const { createdTabs, updatedTabs, updatedWindows } = installBrowserMock(
			[{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites', windowId: 7 }],
			{ ...emptyOpenedTabs(), settingsView: 42 },
		)
		const openManagementTab = await loadOpenManagementTab()
		const hash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')

		await openManagementTab(hash)

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html' + hash } }])
		assert.deepEqual(updatedWindows, [{ windowId: 7, update: { focused: true } }])
	})

	test('replaces a missing tracked management tab', async () => {
		const { createdTabs, storageState } = installBrowserMock([], { settingsView: 42 })
		const openManagementTab = await loadOpenManagementTab()

		await openManagementTab('#settings')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#settings' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('does not replace a website opened in the formerly tracked tab', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock(
			[{ id: 42, url: 'https://example.com/' }],
			{ settingsView: 42 },
		)
		const openManagementTab = await loadOpenManagementTab()

		await openManagementTab('#settings')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#settings' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('replaces a management tab that cannot be focused', async () => {
		const { createdTabs, storageState } = installBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites' }], { settingsView: 42 }, true)
		const openManagementTab = await loadOpenManagementTab()

		await openManagementTab('#settings')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#settings' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('keeps the stored website tab when the active tab is the standalone simulation page', async () => {
		const { storageState } = installBrowserMock([{ id: 77, url: '/html3/simulationStackV3.html' }], emptyOpenedTabs(), false, 12)
		const getLastKnownCurrentTabId = await loadGetLastKnownCurrentTabId()

		assert.equal(await getLastKnownCurrentTabId(), 12)
		assert.equal(storageState.currentTabId, 12)
	})
})

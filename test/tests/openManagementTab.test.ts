import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSimulationStackTargetElementIdFromHash, type ManagementPage } from '../../app/ts/utils/managementPages.js'

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
	useTabsInsteadOfPopup?: boolean
}

function installBrowserMock(tabs: readonly TabRecord[], openedTabs: OpenedTabIds | undefined, updateShouldFail = false, currentTabId?: number, useTabsInsteadOfPopup = false) {
	const createdTabs: TabCreateDetails[] = []
	const createdWindows: TabCreateDetails[] = []
	const updatedTabs: TabUpdateDetails[] = []
	const updatedWindows: WindowUpdateDetails[] = []
	const browserTabs = [...tabs]
	const storageState: StorageState = { idsOfOpenedTabs: openedTabs, currentTabId, useTabsInsteadOfPopup }
	const getStorageValue = (key: string) => key === 'idsOfOpenedTabs' ? storageState.idsOfOpenedTabs : key === 'currentTabId' ? storageState.currentTabId : key === 'useTabsInsteadOfPopup' ? storageState.useTabsInsteadOfPopup : undefined
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
					return [...browserTabs]
				},
				async create(details: TabCreateDetails) {
					createdTabs.push(details)
					browserTabs.push({ id: 99, url: `chrome-extension://test-extension${ details.url }` })
					return { id: 99, ...details }
				},
				async update(tabId: number, update: TabUpdateDetails['update']) {
					if (updateShouldFail) return undefined
					updatedTabs.push({ tabId, update })
					return browserTabs.find((tab) => tab.id === tabId)
				},
			},
			windows: {
				async create(details: TabCreateDetails) {
					createdWindows.push(details)
					return { id: 7, ...details }
				},
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
	return { createdTabs, createdWindows, updatedTabs, updatedWindows, storageState }
}

async function loadManagementNavigation() {
	return await import('../../app/ts/background/managementNavigation.js')
}

async function loadGetLastKnownCurrentTabId() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).getLastKnownCurrentTabId
}

const emptyOpenedTabs = (): OpenedTabIds => ({})

describe('open management tab', () => {
	test('reuses the tracked management tab across management sections', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock(
			[{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites' }],
			{ ...emptyOpenedTabs(), settingsView: 42 },
		)
		const { openManagementPage, openManagementSimulationStack } = await loadManagementNavigation()
		const pages: readonly ManagementPage[] = ['home', 'websites', 'address-book', 'settings']

		for (const page of pages) {
			await openManagementPage(page)
		}
		await openManagementSimulationStack()

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
	test('Safe proposal review reuses the tracked tab when tabs are preferred', async () => {
		const { createdTabs, createdWindows, updatedTabs, storageState } = installBrowserMock([], emptyOpenedTabs(), false, undefined, true)
		const { openManagementPage, openManagementSimulationStackReview } = await loadManagementNavigation()

		await openManagementSimulationStackReview()
		await openManagementPage('home')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#simulation-stack' }])
		assert.deepEqual(updatedTabs, [{ tabId: 99, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#home' } }])
		assert.deepEqual(createdWindows, [])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('Safe proposal review keeps popup mode when tabs are not preferred', async () => {
		const { createdTabs, createdWindows, storageState } = installBrowserMock([], emptyOpenedTabs())
		const { openManagementSimulationStackReview } = await loadManagementNavigation()

		await openManagementSimulationStackReview()

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(createdWindows, [{ url: '/html3/settingsViewV3.html#simulation-stack' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, {})
	})

	test('prefers the current management tab ID over a legacy settings tab ID', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock(
			[
				{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#settings' },
				{ id: 43, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#home' },
			],
			{ settingsView: 42, managementTabId: 43 },
		)
		const { openManagementPage } = await loadManagementNavigation()

		await openManagementPage('diagnostics')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 43, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#diagnostics' } }])
	})

	test('opens and tracks one management tab even when legacy page IDs were stored', async () => {
		const legacyIds = { ...emptyOpenedTabs(), addressBook: 8, websiteAccess: 9, simulationStack: 10 }
		const { createdTabs, storageState } = installBrowserMock([], legacyIds)
		const { openManagementPage } = await loadManagementNavigation()

		await openManagementPage('diagnostics')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#diagnostics' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('reuses and focuses the tracked management tab window', async () => {
		const { createdTabs, updatedTabs, updatedWindows } = installBrowserMock(
			[{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites', windowId: 7 }],
			{ ...emptyOpenedTabs(), settingsView: 42 },
		)
		const { openManagementSimulationStack } = await loadManagementNavigation()

		await openManagementSimulationStack({ type: 'Transaction', transactionIdentifier: 1n })

		assert.deepEqual(createdTabs, [])
		assert.equal(updatedTabs.length, 1)
		assert.equal(updatedTabs[0]?.tabId, 42)
		assert.equal(updatedTabs[0]?.update.active, true)
		assert.equal(updatedTabs[0]?.update.highlighted, true)
		const targetUrl = updatedTabs[0]?.update.url
		assert.ok(targetUrl?.startsWith('/html3/settingsViewV3.html#simulation-stack?'))
		assert.equal(getSimulationStackTargetElementIdFromHash(targetUrl.slice(targetUrl.indexOf('#'))), 'simulation-stack-transaction-0x1')
		assert.deepEqual(updatedWindows, [{ windowId: 7, update: { focused: true } }])
	})

	test('replaces a missing tracked management tab', async () => {
		const { createdTabs, storageState } = installBrowserMock([], { settingsView: 42 })
		const { openManagementPage } = await loadManagementNavigation()

		await openManagementPage('settings')

		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#settings' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('does not replace a website opened in the formerly tracked tab', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock(
			[{ id: 42, url: 'https://example.com/' }],
			{ settingsView: 42 },
		)
		const { openManagementPage } = await loadManagementNavigation()

		await openManagementPage('settings')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/settingsViewV3.html#settings' }])
		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 99 })
	})

	test('replaces a management tab that cannot be focused', async () => {
		const { createdTabs, storageState } = installBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites' }], { settingsView: 42 }, true)
		const { openManagementPage } = await loadManagementNavigation()

		await openManagementPage('settings')

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

import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getManagementTabTarget, getSimulationStackManagementTabTarget, type ManagementOpenRequest } from '../../app/ts/utils/managementPages.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'

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
	addressBook: number | undefined
	settingsView: number | undefined
	websiteAccess: number | undefined
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

async function loadOpenNewTab() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).openNewTab
}

async function loadGetLastKnownCurrentTabId() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).getLastKnownCurrentTabId
}

const emptyOpenedTabs = (): OpenedTabIds => ({
	addressBook: undefined,
	settingsView: undefined,
	websiteAccess: undefined,
	simulationStack: undefined,
})

describe('open management tab', () => {
	test('reuses the tracked settings tab for all three popup management controls', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock(
			[{ id: 42, url: 'chrome-extension://test-extension/html3/settingsViewV3.html#websites' }],
			{ ...emptyOpenedTabs(), settingsView: 42 },
		)
		const openNewTab = await loadOpenNewTab()
		const requests: readonly ManagementOpenRequest[] = ['popup_openWebsiteAccess', 'popup_openAddressBook', 'popup_openSettings']

		for (const request of requests) {
			const target = getManagementTabTarget(request)
			await openNewTab(target.tabName, target.targetHash)
		}
		const simulationStackTarget = getSimulationStackManagementTabTarget()
		await openNewTab(simulationStackTarget.tabName, simulationStackTarget.targetHash)

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#websites' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#address-book' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#settings' } },
			{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/settingsViewV3.html#simulation-stack' } },
		])
	})
})

describe('open simulation stack tab', () => {
	test('focuses the existing simulation stack tab without opening a duplicate', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html' }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { active: true, highlighted: true } }])
	})

	test('focuses the existing simulation stack tab window without opening a duplicate', async () => {
		const { createdTabs, updatedTabs, updatedWindows } = installBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html', windowId: 7 }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { active: true, highlighted: true } }])
		assert.deepEqual(updatedWindows, [{ windowId: 7, update: { focused: true } }])
	})

	test('focuses and targets an existing simulation stack tab', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html' }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()
		const targetHash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')

		await openNewTab('simulationStack', targetHash)

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{
			tabId: 42,
			update: { active: true, highlighted: true, url: `/html3/simulationStackV3.html${ targetHash }` },
		}])
	})

	test('opens and stores a new simulation stack tab when none is tracked', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock([], emptyOpenedTabs())
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/simulationStackV3.html' }])
		assert.equal(storageState.idsOfOpenedTabs?.simulationStack, 99)
	})

	test('opens a new simulation stack tab with a target hash when none is tracked', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock([], emptyOpenedTabs())
		const openNewTab = await loadOpenNewTab()
		const targetHash = getSimulationStackTargetHash({ type: 'Message', messageIdentifier: 2n }, 'test-focus')

		await openNewTab('simulationStack', targetHash)

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: `/html3/simulationStackV3.html${ targetHash }` }])
		assert.equal(storageState.idsOfOpenedTabs?.simulationStack, 99)
	})

	test('opens a replacement tab when the tracked simulation stack tab is gone', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock([], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/simulationStackV3.html' }])
		assert.equal(storageState.idsOfOpenedTabs?.simulationStack, 99)
	})

	test('opens a replacement tab when focusing the tracked simulation stack tab fails', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock([{ id: 42 }], { ...emptyOpenedTabs(), simulationStack: 42 }, true)
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/simulationStackV3.html' }])
		assert.equal(storageState.idsOfOpenedTabs?.simulationStack, 99)
	})

	test('keeps the stored website tab when the active tab is the extension simulation stack page', async () => {
		const { storageState } = installBrowserMock([{ id: 77, url: '/html3/simulationStackV3.html' }], emptyOpenedTabs(), false, 12)
		const getLastKnownCurrentTabId = await loadGetLastKnownCurrentTabId()

		const tabId = await getLastKnownCurrentTabId()

		assert.equal(tabId, 12)
		assert.equal(storageState.currentTabId, 12)
	})

	test('keeps the stored website tab when the active tab is another extension page', async () => {
		const { storageState } = installBrowserMock([{ id: 77, url: 'chrome-extension://other-extension/page.html' }], emptyOpenedTabs(), false, 12)
		const getLastKnownCurrentTabId = await loadGetLastKnownCurrentTabId()

		const tabId = await getLastKnownCurrentTabId()

		assert.equal(tabId, 12)
		assert.equal(storageState.currentTabId, 12)
	})

	test('clears a stale simulation stack hash when focusing the existing stack tab without a target', async () => {
		const targetHash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42, url: `chrome-extension://test-extension/html3/simulationStackV3.html${ targetHash }` }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { active: true, highlighted: true, url: '/html3/simulationStackV3.html' } }])
	})
})

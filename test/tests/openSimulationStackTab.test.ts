import * as assert from 'assert'
import { describe, test } from 'bun:test'

type TabRecord = {
	readonly id: number
	readonly url?: string
}

type TabCreateDetails = {
	readonly url: string
}

type TabUpdateDetails = {
	readonly tabId: number
	readonly update: {
		readonly active?: boolean
		readonly highlighted?: boolean
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
}

function installBrowserMock(tabs: readonly TabRecord[], openedTabs: OpenedTabIds | undefined, updateShouldFail = false) {
	const createdTabs: TabCreateDetails[] = []
	const updatedTabs: TabUpdateDetails[] = []
	const storageState: StorageState = { idsOfOpenedTabs: openedTabs }
	const getStorageValue = (key: string) => key === 'idsOfOpenedTabs' ? storageState.idsOfOpenedTabs : undefined
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
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
					return { id: tabId }
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return { createdTabs, updatedTabs, storageState }
}

async function loadOpenNewTab() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).openNewTab
}

const emptyOpenedTabs = (): OpenedTabIds => ({
	addressBook: undefined,
	settingsView: undefined,
	websiteAccess: undefined,
	simulationStack: undefined,
})

describe('open simulation stack tab', () => {
	test('focuses the existing simulation stack tab without opening a duplicate', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42 }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(createdTabs, [])
		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { active: true, highlighted: true } }])
	})

	test('opens and stores a new simulation stack tab when none is tracked', async () => {
		const { createdTabs, updatedTabs, storageState } = installBrowserMock([], emptyOpenedTabs())
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: '/html3/simulationStackV3.html' }])
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
})

import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'
import { PartialIdsOfOpenedTabs } from '../../app/ts/utils/storageUtils.js'
import type { BrowserMock, MockTabSeed } from '../harness/browserMock.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

type OpenedTabIds = {
	addressBook: number | undefined
	settingsView: number | undefined
	websiteAccess: number | undefined
	simulationStack?: number | undefined
}

const SIMULATION_STACK_PAGE = '/html3/simulationStackV3.html'
const EXTENSION_ID = 'test-extension'

const installBrowserMock = createPerTestBrowserMockInstaller()
const CREATED_TAB_ID = 99

function installNavigationBrowserMock(tabs: readonly MockTabSeed[], openedTabs: OpenedTabIds, updateShouldFail = false, currentTabId?: number) {
	const browserMock = installBrowserMock({
		extensionId: EXTENSION_ID,
		storage: { local: currentTabId === undefined ? { idsOfOpenedTabs: openedTabs } : { idsOfOpenedTabs: openedTabs, currentTabId } },
		tabs,
		windows: [{ id: 1, focused: true }, { id: 7 }],
		firstCreatedIds: { tab: CREATED_TAB_ID },
	})
	// Simulates a tab that closes between the tab query and the focus update, which Chrome reports as a missing tab.
	if (updateShouldFail) browserMock.browser.tabs.update = async (tabId) => { throw new Error(`No tab with id: ${ tabId }.`) }
	return browserMock
}

const readStoredSimulationStackTabId = (browserMock: BrowserMock) => {
	const { idsOfOpenedTabs } = browserMock.readStorage()
	return PartialIdsOfOpenedTabs.parse(idsOfOpenedTabs).simulationStack
}

async function loadOpenNewTab() {
	return (await import('../../app/ts/background/popupMessageHandlers/navigation.js')).openNewTab
}

async function loadGetLastKnownCurrentTabId() {
	return (await import('../../app/ts/background/currentTab.js')).getLastKnownCurrentTabId
}

const emptyOpenedTabs = (): OpenedTabIds => ({
	addressBook: undefined,
	settingsView: undefined,
	websiteAccess: undefined,
	simulationStack: undefined,
})

describe('open simulation stack tab', () => {
	test('focuses the existing simulation stack tab without opening a duplicate', async () => {
		const { calls } = installNavigationBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html' }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(calls.tabsCreate, [])
		assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, updateProperties: { active: true, highlighted: true } }])
	})

	test('focuses the existing simulation stack tab window without opening a duplicate', async () => {
		const { calls } = installNavigationBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html', windowId: 7 }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(calls.tabsCreate, [])
		assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, updateProperties: { active: true, highlighted: true } }])
		assert.deepEqual(calls.windowsUpdate, [{ windowId: 7, updateInfo: { focused: true } }])
	})

	test('focuses and targets an existing simulation stack tab', async () => {
		const { calls } = installNavigationBrowserMock([{ id: 42, url: 'chrome-extension://test-extension/html3/simulationStackV3.html' }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()
		const targetHash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')

		await openNewTab('simulationStack', targetHash)

		assert.deepEqual(calls.tabsCreate, [])
		assert.deepEqual(calls.tabsUpdate, [{
			tabId: 42,
			updateProperties: { active: true, highlighted: true, url: `${ SIMULATION_STACK_PAGE }${ targetHash }` },
		}])
	})

	test('opens and stores a new simulation stack tab when none is tracked', async () => {
		const browserMock = installNavigationBrowserMock([], emptyOpenedTabs())
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(browserMock.calls.tabsUpdate, [])
		assert.deepEqual(browserMock.calls.tabsCreate, [{ url: SIMULATION_STACK_PAGE }])
		assert.equal(readStoredSimulationStackTabId(browserMock), CREATED_TAB_ID)
	})

	test('opens a new simulation stack tab with a target hash when none is tracked', async () => {
		const browserMock = installNavigationBrowserMock([], emptyOpenedTabs())
		const openNewTab = await loadOpenNewTab()
		const targetHash = getSimulationStackTargetHash({ type: 'Message', messageIdentifier: 2n }, 'test-focus')

		await openNewTab('simulationStack', targetHash)

		assert.deepEqual(browserMock.calls.tabsUpdate, [])
		assert.deepEqual(browserMock.calls.tabsCreate, [{ url: `${ SIMULATION_STACK_PAGE }${ targetHash }` }])
		assert.equal(readStoredSimulationStackTabId(browserMock), CREATED_TAB_ID)
	})

	test('opens a replacement tab when the tracked simulation stack tab is gone', async () => {
		const browserMock = installNavigationBrowserMock([], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(browserMock.calls.tabsUpdate, [])
		assert.deepEqual(browserMock.calls.tabsCreate, [{ url: SIMULATION_STACK_PAGE }])
		assert.equal(readStoredSimulationStackTabId(browserMock), CREATED_TAB_ID)
	})

	test('opens a replacement tab when focusing the tracked simulation stack tab fails', async () => {
		const browserMock = installNavigationBrowserMock([{ id: 42 }], { ...emptyOpenedTabs(), simulationStack: 42 }, true)
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(browserMock.calls.tabsUpdate, [])
		assert.deepEqual(browserMock.calls.tabsCreate, [{ url: SIMULATION_STACK_PAGE }])
		assert.equal(readStoredSimulationStackTabId(browserMock), CREATED_TAB_ID)
	})

	test('keeps the stored website tab when the active tab is the extension simulation stack page', async () => {
		const browserMock = installNavigationBrowserMock([{ id: 77, url: SIMULATION_STACK_PAGE, active: true }], emptyOpenedTabs(), false, 12)
		const getLastKnownCurrentTabId = await loadGetLastKnownCurrentTabId()

		const tabId = await getLastKnownCurrentTabId()

		const { currentTabId } = browserMock.readStorage()
		assert.equal(tabId, 12)
		assert.equal(currentTabId, 12)
	})

	test('keeps the stored website tab when the active tab is another extension page', async () => {
		const browserMock = installNavigationBrowserMock([{ id: 77, url: 'chrome-extension://other-extension/page.html', active: true }], emptyOpenedTabs(), false, 12)
		const getLastKnownCurrentTabId = await loadGetLastKnownCurrentTabId()

		const tabId = await getLastKnownCurrentTabId()

		const { currentTabId } = browserMock.readStorage()
		assert.equal(tabId, 12)
		assert.equal(currentTabId, 12)
	})

	test('clears a stale simulation stack hash when focusing the existing stack tab without a target', async () => {
		const targetHash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'test-focus')
		const { calls } = installNavigationBrowserMock([{ id: 42, url: `chrome-extension://test-extension/html3/simulationStackV3.html${ targetHash }` }], { ...emptyOpenedTabs(), simulationStack: 42 })
		const openNewTab = await loadOpenNewTab()

		await openNewTab('simulationStack')

		assert.deepEqual(calls.tabsCreate, [])
		assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, updateProperties: { active: true, highlighted: true, url: SIMULATION_STACK_PAGE } }])
	})
})

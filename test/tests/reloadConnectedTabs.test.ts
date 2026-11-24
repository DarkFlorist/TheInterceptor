import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

type ReloadBrowserMockOptions = {
	// Reloading a tab that is not listed rejects with Chrome's "No tab with id: N." error.
	readonly existingTabIds?: readonly number[]
	// Reloading a listed tab records the call and then fails with this error.
	readonly reloadErrorsByTab?: ReadonlyMap<number, Error>
}

function installReloadBrowserMock({ existingTabIds = [10, 11], reloadErrorsByTab = new Map<number, Error>() }: ReloadBrowserMockOptions) {
	const installedMock = installBrowserMock({ tabs: existingTabIds.map((id) => ({ id })) })
	const reloadTab = installedMock.browser.tabs.reload
	installedMock.browser.tabs.reload = async (tabId) => {
		await reloadTab(tabId)
		const reloadError = reloadErrorsByTab.get(tabId)
		if (reloadError !== undefined) throw reloadError
	}
	return { sentMessages: installedMock.calls.runtimeSendMessage, reloadedTabs: installedMock.calls.tabsReload }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/utils/unexpectedErrorStorage.js'),
	}
}

const websiteTabConnections: WebsiteTabConnections = new Map([[10, { connections: {} }]])
const multiTabWebsiteTabConnections: WebsiteTabConnections = new Map([
	[10, { connections: {} }],
	[11, { connections: {} }],
])

describe('reloadConnectedTabs', () => {
	test('ignores tabs that disappeared before reload', async () => {
		const { sentMessages, reloadedTabs } = installReloadBrowserMock({ existingTabIds: [11] })
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(websiteTabConnections)

		assert.deepEqual(reloadedTabs, [10])
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(sentMessages, [])
	})

	test('ignores Firefox invalid tab reload errors', async () => {
		const { sentMessages, reloadedTabs } = installReloadBrowserMock({ reloadErrorsByTab: new Map([[10, new Error('Invalid tab ID: 10')]]) })
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(websiteTabConnections)

		assert.deepEqual(reloadedTabs, [10])
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(sentMessages, [])
	})

	test('records unexpected reload failures', async () => {
		const { reloadedTabs } = installReloadBrowserMock({ reloadErrorsByTab: new Map([[10, new Error('reload failed')]]) })
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(websiteTabConnections)

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.deepEqual(reloadedTabs, [10])
		assert.equal(latestUnexpectedError?.data.message, 'reload failed')
		assert.equal(latestUnexpectedError?.data.code, 'connected_tab_reload_failed')
	})

	test('continues reloading later tabs after a missing-tab race', async () => {
		const { sentMessages, reloadedTabs } = installReloadBrowserMock({ existingTabIds: [11] })
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(multiTabWebsiteTabConnections)

		assert.deepEqual(reloadedTabs, [10, 11])
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(sentMessages, [])
	})

	test('continues reloading later tabs after an unexpected reload failure', async () => {
		const { reloadedTabs } = installReloadBrowserMock({ reloadErrorsByTab: new Map([[10, new Error('reload failed')]]) })
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(multiTabWebsiteTabConnections)

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.deepEqual(reloadedTabs, [10, 11])
		assert.equal(latestUnexpectedError?.data.message, 'reload failed')
		assert.equal(latestUnexpectedError?.data.code, 'connected_tab_reload_failed')
	})
})

import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('tryFocusingTabOrWindow browser targets', () => {
	test('ignores missing tabs before focusing', async () => {
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')
		// No tab 7 is seeded, so browser.tabs.get rejects with Chrome's "No tab with id: 7." error.
		const browserMock = installBrowserMock()

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 7 })

		assert.equal(result, undefined)
		assert.deepEqual(browserMock.calls.tabsUpdate.map(({ tabId }) => tabId), [])
		assert.deepEqual(browserMock.calls.windowsUpdate.map(({ windowId }) => windowId), [])
	})

	test('focuses the tab and its parent window when both still exist', async () => {
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')
		const browserMock = installBrowserMock({ windows: [{ id: 18 }], tabs: [{ id: 8, windowId: 18 }] })

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 8 })

		assert.deepEqual(result, browserMock.getTab(8))
		assert.equal(result?.id, 8)
		assert.deepEqual(browserMock.calls.tabsUpdate.map(({ tabId }) => tabId), [8])
		assert.deepEqual(browserMock.calls.windowsUpdate.map(({ windowId }) => windowId), [18])
	})
})

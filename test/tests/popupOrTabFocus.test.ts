import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('popup/tab focusing', () => {
	test('ignores missing originating tabs so reject flows can continue', async () => {
		// No tab 7 is seeded, so browser.tabs.get rejects with Chrome's "No tab with id: 7." error.
		const browserMock = installBrowserMock()
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 7 })

		assert.equal(result, undefined)
		assert.deepEqual(browserMock.calls.windowsUpdate, [])
		assert.deepEqual(browserMock.calls.tabsUpdate, [])
	})
})

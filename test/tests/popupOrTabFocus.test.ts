import * as assert from 'assert'
import { describe, test } from 'bun:test'

function installBrowserMock() {
	const windowUpdates: Array<{ windowId: number, updateInfo: browser.windows._UpdateUpdateInfo }> = []
	const tabUpdates: Array<{ tabId: number, updateInfo: browser.tabs._UpdateUpdateProperties }> = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
			},
			tabs: {
				async get() {
					throw new Error('No tab with id: 7.')
				},
				async update(tabId: number, updateInfo: browser.tabs._UpdateUpdateProperties) {
					tabUpdates.push({ tabId, updateInfo })
					return { id: tabId }
				},
			},
			windows: {
				async update(windowId: number, updateInfo: browser.windows._UpdateUpdateInfo) {
					windowUpdates.push({ windowId, updateInfo })
					return { id: windowId }
				},
			},
		},
	})

	return { windowUpdates, tabUpdates }
}

describe('popup/tab focusing', () => {
	test('ignores missing originating tabs so reject flows can continue', async () => {
		const { windowUpdates, tabUpdates } = installBrowserMock()
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 7 })

		assert.equal(result, undefined)
		assert.deepEqual(windowUpdates, [])
		assert.deepEqual(tabUpdates, [])
	})
})

import * as assert from 'assert'
import { afterEach, describe, test } from 'bun:test'

type BrowserMockOptions = {
	readonly tabGetError?: Error
	readonly tab?: browser.tabs.Tab
}

const tabUpdateCalls: number[] = []
const windowUpdateCalls: number[] = []

function installBrowserMock(options: BrowserMockOptions = {}) {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: undefined,
			},
			tabs: {
				async get() {
					if (options.tabGetError !== undefined) throw options.tabGetError
					return options.tab
				},
				async update(tabId: number) {
					tabUpdateCalls.push(tabId)
					return { id: tabId }
				},
			},
			windows: {
				async update(windowId: number) {
					windowUpdateCalls.push(windowId)
					return { id: windowId }
				},
			},
		},
	})
}

afterEach(() => {
	tabUpdateCalls.splice(0, tabUpdateCalls.length)
	windowUpdateCalls.splice(0, windowUpdateCalls.length)
})

describe('tryFocusingTabOrWindow browser targets', () => {
	test('ignores missing tabs before focusing', async () => {
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')
		installBrowserMock({ tabGetError: new Error('No tab with id: 7.') })

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 7 })

		assert.equal(result, undefined)
		assert.deepEqual(tabUpdateCalls, [])
		assert.deepEqual(windowUpdateCalls, [])
	})

	test('focuses the tab and its parent window when both still exist', async () => {
		const { tryFocusingTabOrWindow } = await import('../../app/ts/utils/popupOrTab.js')
		installBrowserMock({ tab: { id: 8, windowId: 18 } })

		const result = await tryFocusingTabOrWindow({ type: 'tab', id: 8 })

		assert.deepEqual(result, { id: 8 })
		assert.deepEqual(tabUpdateCalls, [8])
		assert.deepEqual(windowUpdateCalls, [18])
	})
})

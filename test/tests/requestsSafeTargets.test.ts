import * as assert from 'assert'
import { describe, test } from 'bun:test'

type BrowserMockOptions = {
	readonly tabGetError?: Error
	readonly windowGetError?: Error
	readonly tabUpdateError?: Error
	readonly windowUpdateError?: Error
	readonly runtimeLastError?: browser.runtime._LastError | undefined | null
}

function installBrowserMock(options: BrowserMockOptions = {}) {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: options.runtimeLastError ?? null,
			},
			tabs: {
				async get(tabId: number) {
					if (options.tabGetError !== undefined) throw options.tabGetError
					return { id: tabId }
				},
				async update(tabId: number) {
					if (options.tabUpdateError !== undefined) throw options.tabUpdateError
					return { id: tabId }
				},
			},
			windows: {
				async get(windowId: number) {
					if (options.windowGetError !== undefined) throw options.windowGetError
					return { id: windowId }
				},
				async update(windowId: number) {
					if (options.windowUpdateError !== undefined) throw options.windowUpdateError
					return { id: windowId }
				},
			},
		},
	})
}

async function loadRequestsModule() {
	return await import('../../app/ts/utils/requests.js')
}

describe('safe browser target helpers', () => {
	test('return undefined for missing tab and window targets', async () => {
		const { safeGetTab, safeGetWindow, updateTabIfExists, updateWindowIfExists } = await loadRequestsModule()

		installBrowserMock({
			tabGetError: new Error('No tab with id: 7.'),
			windowGetError: new Error('No window with id: 8.'),
			tabUpdateError: new Error('Invalid tab ID: 9'),
			windowUpdateError: new Error('Invalid window ID: 10'),
		})

		assert.equal(await safeGetTab(7), undefined)
		assert.equal(await safeGetWindow(8), undefined)
		assert.equal(await updateTabIfExists(9, { active: true }), undefined)
		assert.equal(await updateWindowIfExists(10, { focused: true }), undefined)
	})

	test('rethrows unexpected tab and window API failures', async () => {
		const { safeGetTab, safeGetWindow, updateTabIfExists, updateWindowIfExists } = await loadRequestsModule()

		installBrowserMock({ tabGetError: new Error('tabs permission missing') })
		await assert.rejects(async () => await safeGetTab(7), /tabs permission missing/)

		installBrowserMock({ windowGetError: new Error('windows permission missing') })
		await assert.rejects(async () => await safeGetWindow(8), /windows permission missing/)

		installBrowserMock({ tabUpdateError: new Error('tab update failed') })
		await assert.rejects(async () => await updateTabIfExists(9, { active: true }), /tab update failed/)

		installBrowserMock({ windowUpdateError: new Error('window update failed') })
		await assert.rejects(async () => await updateWindowIfExists(10, { focused: true }), /window update failed/)
	})

	test('rethrows unexpected runtime lastError values', async () => {
		const { safeGetTab } = await loadRequestsModule()

		installBrowserMock({ runtimeLastError: { message: 'runtime unavailable' } })

		await assert.rejects(async () => await safeGetTab(7), /runtime unavailable/)
	})
})

import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

// Tab 7, tab 9, window 8 and window 10 exist, so every lookup and update succeeds until a test removes a target or replaces an API method to inject a failure.
function installTargetsBrowserMock() {
	return installBrowserMock({ windows: [{ id: 8, focused: true }, { id: 10 }], tabs: [{ id: 7, windowId: 8 }, { id: 9, windowId: 10 }] }).browser
}

async function loadRequestsModule() {
	return await import('../../app/ts/utils/requests.js')
}

describe('browser target helpers', () => {
	test('classify missing tab and window target errors', async () => {
		const { isMissingBrowserTargetError } = await loadRequestsModule()

		assert.equal(isMissingBrowserTargetError(new Error('No tab with id: 7.')), true)
		assert.equal(isMissingBrowserTargetError(new Error('No window with id: 8.')), true)
		assert.equal(isMissingBrowserTargetError(new Error('Invalid tab ID: 9')), true)
		assert.equal(isMissingBrowserTargetError(new Error('Invalid window ID: 10')), true)
		assert.equal(isMissingBrowserTargetError(new Error('tabs permission missing')), false)
		assert.equal(isMissingBrowserTargetError('No tab with id: 7.'), false)
	})

	test('return undefined for missing tab and window targets', async () => {
		const { getTabIfExists, getWindowIfExists, updateTabIfExists, updateWindowIfExists } = await loadRequestsModule()

		const browser = installTargetsBrowserMock()
		// Removing the targets makes tabs.get and windows.get reject with Chrome's "No tab with id: 7." and "No window with id: 8." errors.
		await browser.tabs.remove(7)
		await browser.windows.remove(8)
		// Firefox reports missing update targets as "Invalid tab ID" and "Invalid window ID" instead.
		browser.tabs.update = async () => { throw new Error('Invalid tab ID: 9') }
		browser.windows.update = async () => { throw new Error('Invalid window ID: 10') }

		assert.equal(await getTabIfExists(7), undefined)
		assert.equal(await getWindowIfExists(8), undefined)
		assert.equal(await updateTabIfExists(9, { active: true }), undefined)
		assert.equal(await updateWindowIfExists(10, { focused: true }), undefined)
	})

	test('rethrows unexpected tab and window API failures', async () => {
		const { getTabIfExists, getWindowIfExists, updateTabIfExists, updateWindowIfExists } = await loadRequestsModule()

		const browser = installTargetsBrowserMock()
		browser.tabs.get = async () => { throw new Error('tabs permission missing') }
		await assert.rejects(async () => await getTabIfExists(7), /tabs permission missing/)

		browser.windows.get = async () => { throw new Error('windows permission missing') }
		await assert.rejects(async () => await getWindowIfExists(8), /windows permission missing/)

		browser.tabs.update = async () => { throw new Error('tab update failed') }
		await assert.rejects(async () => await updateTabIfExists(9, { active: true }), /tab update failed/)

		browser.windows.update = async () => { throw new Error('window update failed') }
		await assert.rejects(async () => await updateWindowIfExists(10, { focused: true }), /window update failed/)
	})

	test('rethrows unexpected runtime lastError values', async () => {
		const { getTabIfExists } = await loadRequestsModule()

		const browser = installTargetsBrowserMock()
		browser.runtime.lastError = { message: 'runtime unavailable' }

		await assert.rejects(async () => await getTabIfExists(7), /runtime unavailable/)
	})

	test('doesTabExist only returns false for missing tabs', async () => {
		const { doesTabExist } = await loadRequestsModule()

		const browser = installTargetsBrowserMock()
		assert.equal(await doesTabExist(7), true)

		await browser.tabs.remove(7)
		assert.equal(await doesTabExist(7), false)

		browser.tabs.get = async () => { throw new Error('tabs permission missing') }
		await assert.rejects(async () => await doesTabExist(7), /tabs permission missing/)
	})
})

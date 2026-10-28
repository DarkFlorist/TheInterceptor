import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { OpenWebPage } from '../../app/ts/types/interceptor-messages.js'
import type { MockTabSeed } from '../harness/browserMock.js'
import { replaceProperty } from '../harness/globals.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { importAllPopupMessageHandlers } from './popupMessageHandlerModules.js'

function createOpenWebPageRequest(tabId: number, url: string): OpenWebPage {
	return {
		method: 'popup_openWebPage',
		data: {
			url,
			websiteSocket: {
				tabId,
				connectionName: 1n,
			},
		},
	}
}

const installBrowserMock = createPerTestBrowserMockInstaller()

function installTabsBrowserMock(tabs: readonly MockTabSeed[], updateShouldFail = false) {
	const browserMock = installBrowserMock({ extensionId: 'test-extension', tabs })
	if (updateShouldFail) browserMock.browser.tabs.update = async () => { throw new Error('tab update failed') }
	return browserMock
}

async function loadOpenWebPage() {
	return (await importAllPopupMessageHandlers()).openWebPage
}

describe('openWebPage', () => {
	test('updates the existing website tab without opening a duplicate', async () => {
		const { calls } = installTabsBrowserMock([{ id: 42 }])
		const openWebPage = await loadOpenWebPage()

		await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))

		assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, updateProperties: { url: 'https://example.test/next', active: true } }])
		assert.deepEqual(calls.tabsCreate, [])
	})

	test('creates a new tab when the original tab is gone', async () => {
		const { calls } = installTabsBrowserMock([])
		const openWebPage = await loadOpenWebPage()

		await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))

		assert.deepEqual(calls.tabsUpdate, [])
		assert.deepEqual(calls.tabsCreate, [{ url: 'https://example.test/next', active: true }])
	})

	test('creates a fallback tab when updating the original tab fails', async () => {
		const { calls } = installTabsBrowserMock([{ id: 42 }], true)
		const openWebPage = await loadOpenWebPage()
		const restoreWarn = replaceProperty(console, 'warn', () => undefined)

		try {
			await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))
		} finally {
			restoreWarn()
		}

		assert.deepEqual(calls.tabsUpdate, [])
		assert.deepEqual(calls.tabsCreate, [{ url: 'https://example.test/next', active: true }])
	})
})

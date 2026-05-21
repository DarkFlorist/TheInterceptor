import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { OpenWebPage } from '../../app/ts/types/interceptor-messages.js'

type TabRecord = {
	readonly id: number
	readonly url?: string
}

type TabCreateDetails = {
	readonly url: string
	readonly active: boolean
}

type TabUpdateDetails = {
	readonly tabId: number
	readonly update: TabCreateDetails
}

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

function installBrowserMock(tabs: readonly TabRecord[], updateShouldFail = false) {
	const createdTabs: TabCreateDetails[] = []
	const updatedTabs: TabUpdateDetails[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
			},
			tabs: {
				async query() {
					return [...tabs]
				},
				async create(details: TabCreateDetails) {
					createdTabs.push(details)
				},
				async update(tabId: number, update: TabCreateDetails) {
					if (updateShouldFail) throw new Error('tab update failed')
					updatedTabs.push({ tabId, update })
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: { runtime: { id: 'test-extension' } },
	})
	return { createdTabs, updatedTabs }
}

async function loadOpenWebPage() {
	return (await import('../../app/ts/background/popupMessageHandlers.js')).openWebPage
}

describe('openWebPage', () => {
	test('updates the existing website tab without opening a duplicate', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42 }])
		const openWebPage = await loadOpenWebPage()

		await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))

		assert.deepEqual(updatedTabs, [{ tabId: 42, update: { url: 'https://example.test/next', active: true } }])
		assert.deepEqual(createdTabs, [])
	})

	test('creates a new tab when the original tab is gone', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([])
		const openWebPage = await loadOpenWebPage()

		await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: 'https://example.test/next', active: true }])
	})

	test('creates a fallback tab when updating the original tab fails', async () => {
		const { createdTabs, updatedTabs } = installBrowserMock([{ id: 42 }], true)
		const openWebPage = await loadOpenWebPage()
		const originalWarn = console.warn
		console.warn = () => undefined

		try {
			await openWebPage(createOpenWebPageRequest(42, 'https://example.test/next'))
		} finally {
			console.warn = originalWarn
		}

		assert.deepEqual(updatedTabs, [])
		assert.deepEqual(createdTabs, [{ url: 'https://example.test/next', active: true }])
	})
})

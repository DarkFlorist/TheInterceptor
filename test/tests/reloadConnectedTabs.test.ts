import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'

type RuntimeMessage = {
	readonly method?: string
}

function installBrowserMock(reloadError: Error) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []
	const reloadedTabs: number[] = []
	const getStorageItems = (keys?: string | string[] | Record<string, unknown> | null) => {
		if (keys === undefined || keys === null) return { ...storageState }
		if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
		if (typeof keys === 'string') return { [keys]: storageState[keys] }
		return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
	}

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: RuntimeMessage) {
					sentMessages.push(message)
					return undefined
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) { return getStorageItems(keys) },
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
			tabs: {
				async query() { return [] },
				async get() { return undefined },
				async update() { return undefined },
				async reload(tabId: number) {
					reloadedTabs.push(tabId)
					throw reloadError
				},
				onUpdated: { addListener: () => undefined, removeListener: () => undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get() { return undefined },
				async update() { return undefined },
			},
			action: {
				async setIcon() { return undefined },
				async setTitle() { return undefined },
				async setBadgeText() { return undefined },
				async setBadgeBackgroundColor() { return undefined },
			},
			browserAction: {
				async setIcon() { return undefined },
				async setTitle() { return undefined },
				async setBadgeText() { return undefined },
				async setBadgeBackgroundColor() { return undefined },
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

	return { sentMessages, reloadedTabs }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

const websiteTabConnections: WebsiteTabConnections = new Map([[10, { connections: {} }]])

describe('reloadConnectedTabs', () => {
	test('ignores tabs that disappeared before reload', async () => {
		const { sentMessages, reloadedTabs } = installBrowserMock(new Error('No tab with id: 10.'))
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(websiteTabConnections)

		assert.deepEqual(reloadedTabs, [10])
		assert.equal(await getLatestUnexpectedError(), undefined)
		assert.deepEqual(sentMessages, [])
	})

	test('records unexpected reload failures', async () => {
		const { reloadedTabs } = installBrowserMock(new Error('reload failed'))
		const { reloadConnectedTabs, getLatestUnexpectedError } = await loadModules()

		await reloadConnectedTabs(websiteTabConnections)

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.deepEqual(reloadedTabs, [10])
		assert.equal(latestUnexpectedError?.data.message, 'reload failed')
		assert.equal(latestUnexpectedError?.data.code, 'connected_tab_reload_failed')
	})
})

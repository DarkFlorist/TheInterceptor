import * as assert from 'assert'
import { describe, test } from 'bun:test'

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	globalThis.browser = {
		runtime: {
			lastError: null,
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			query: async () => [],
			get: async () => undefined,
			update: async () => undefined,
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			get: async () => undefined,
			update: async () => undefined,
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
	} as unknown as typeof globalThis.browser

	return { storageState }
}

describe('popup refresh generation persistence', () => {
	test('keeps in-memory generation above persisted restart value', async () => {
		const { storageState } = installBrowserMock()
		const previousGeneration = 10_000_000_000_000
		storageState.popupRefreshGeneration = previousGeneration

		const { initializePopupRefreshGeneration, bumpPopupRefreshGeneration, getPopupRefreshGeneration } = await import('../../app/ts/background/popupRefreshGeneration.js')
		await initializePopupRefreshGeneration()
		const afterInitialize = getPopupRefreshGeneration()
		assert.equal(afterInitialize >= previousGeneration, true)

		const afterBump = bumpPopupRefreshGeneration()
		assert.equal(afterBump > previousGeneration, true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(storageState.popupRefreshGeneration, afterBump)
	})
})


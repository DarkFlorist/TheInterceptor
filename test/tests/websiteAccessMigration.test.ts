import * as assert from 'assert'
import { describe, test } from 'bun:test'

const defineGlobal = (name: PropertyKey, value: unknown) =>
	Object.defineProperty(globalThis, name, {
		value,
		configurable: true,
		writable: true,
	})

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	defineGlobal('browser', {
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys))
						return Object.fromEntries(
							keys.map((key) => [key, storageState[key]]),
						)
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(
						Object.entries(keys).map(([key, defaultValue]) => [
							key,
							key in storageState ? storageState[key] : defaultValue,
						]),
					)
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys])
						delete storageState[key]
				},
			},
		},
	})
	return storageState
}

describe('website access migration', () => {
	test('sanitizes stored remote website icons', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import(
			'../../app/ts/background/websiteAccessMigration.js'
		)
		storageState.websiteAccess = [
			{
				website: {
					websiteOrigin: 'remote.example',
					icon: 'https://remote.example/favicon.png',
					title: 'Remote',
				},
				access: true,
			},
			{
				website: {
					websiteOrigin: 'cached.example',
					icon: 'data:image/png;base64,Y2FjaGVk',
					title: 'Cached',
				},
				access: true,
			},
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess))
			throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.icon, undefined)
		assert.equal(
			storageState.websiteAccess[1]?.website.icon,
			'data:image/png;base64,Y2FjaGVk',
		)
	})

	test('normalizes host scoped settings across sibling origins', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import(
			'../../app/ts/background/websiteAccessMigration.js'
		)
		storageState.websiteAccess = [
			{
				website: {
					websiteOrigin: 'localhost:3000',
					icon: undefined,
					title: 'App A',
				},
				access: true,
				interceptorDisabled: true,
			},
			{
				website: {
					websiteOrigin: 'localhost:5173',
					icon: undefined,
					title: 'App B',
				},
				access: true,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: {
					websiteOrigin: 'otherhost.test:3000',
					icon: undefined,
					title: 'Other Host',
				},
				access: true,
			},
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess))
			throw new Error('Expected websiteAccess to remain an array')
		assert.deepEqual(storageState.websiteAccess.slice(0, 2), [
			{
				website: {
					websiteOrigin: 'localhost:3000',
					icon: undefined,
					title: 'App A',
				},
				access: true,
				interceptorDisabled: true,
				declarativeNetRequestBlockMode: 'block-all',
			},
			{
				website: {
					websiteOrigin: 'localhost:5173',
					icon: undefined,
					title: 'App B',
				},
				access: true,
				interceptorDisabled: true,
				declarativeNetRequestBlockMode: 'block-all',
			},
		])
	})
})

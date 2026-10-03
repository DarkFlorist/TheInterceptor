import * as assert from 'assert'
import { describe, test } from 'bun:test'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	defineGlobal('browser', {
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
	})
	return storageState
}

describe('website access migration', () => {
	test('sanitizes stored remote website icons', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.icon, undefined)
		assert.equal(storageState.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})
})

test('persists explicit alias permissions independently of legacy entry ordering', async () => {
	const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
	const legacy = { website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy' }, access: false }
	const alias = { website: { websiteOrigin: 'https://example.test/path', icon: undefined, title: 'Explicit' }, access: true, addressAccess: [{ address: '0x0000000000000000000000000000000000000001', access: true }], interceptorDisabled: true }
	for (const entries of [[alias, legacy], [legacy, alias]]) {
		const storage = installBrowserMock()
		storage.websiteAccess = entries
		await migrateWebsiteAccess()
		const expected = [{ ...alias, website: { ...alias.website, websiteOrigin: 'https://example.test' } }]
		assert.deepEqual(storage.websiteAccess, expected)
		await migrateWebsiteAccess()
		assert.deepEqual(storage.websiteAccess, expected)
	}
})

test('persists legacy hostname blocks alongside explicit origin consent', async () => {
	const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
	const legacy = { website: { websiteOrigin: 'example.test', icon: undefined, title: 'Legacy' }, access: false, interceptorDisabled: true, declarativeNetRequestBlockMode: 'block-all' }
	const explicit = { website: { ...legacy.website, websiteOrigin: 'https://example.test', title: 'Explicit' }, access: true, interceptorDisabled: false }
	for (const entries of [[legacy, explicit], [explicit, legacy]]) {
		const storage = installBrowserMock()
		storage.websiteAccess = entries
		await migrateWebsiteAccess()
		const expected = [{ ...explicit, declarativeNetRequestBlockMode: 'block-all' }]
		assert.deepEqual(storage.websiteAccess, expected)
		await migrateWebsiteAccess()
		assert.deepEqual(storage.websiteAccess, expected)
	}
})

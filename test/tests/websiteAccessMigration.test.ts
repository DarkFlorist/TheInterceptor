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
			{ website: { websiteOrigin: 'https://remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'https://cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.icon, undefined)
		assert.equal(storageState.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})

	test('migrates legacy host-only access to schemeful http and https origins', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
		storageState.websiteAccess = [{
			website: { websiteOrigin: 'legacy.example:8443', icon: 'https://legacy.example/favicon.png', title: 'Legacy' },
			access: true,
			addressAccess: [{ address: '0x1111111111111111111111111111111111111111', access: true }],
			interceptorDisabled: true,
			declarativeNetRequestBlockMode: 'block-all',
		}]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.deepEqual(storageState.websiteAccess.map((entry) => entry.website.websiteOrigin), [
			'https://legacy.example:8443',
			'http://legacy.example:8443',
		])
		assert.equal(storageState.websiteAccess[0]?.website.icon, undefined)
		assert.equal(storageState.websiteAccess[1]?.access, true)
		assert.equal(storageState.websiteAccess[1]?.interceptorDisabled, true)
		assert.equal(storageState.websiteAccess[1]?.declarativeNetRequestBlockMode, 'block-all')
		assert.deepEqual(storageState.websiteAccess[1]?.addressAccess, [{ address: '0x1111111111111111111111111111111111111111', access: true }])
	})

	test('keeps exact schemeful entries when migrating conflicting legacy access', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'conflict.example', icon: undefined, title: 'Legacy' }, access: true },
			{ website: { websiteOrigin: 'https://conflict.example', icon: undefined, title: 'HTTPS' }, access: false },
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.deepEqual(storageState.websiteAccess.map((entry) => [entry.website.websiteOrigin, entry.access]), [
			['http://conflict.example', true],
			['https://conflict.example', false],
		])
	})
})

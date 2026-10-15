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

	test('retains legacy host-only access for explicit rebinding without guessing a scheme', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'example.com', icon: undefined, title: 'Production' }, access: true },
			{ website: { websiteOrigin: 'example.test:8080', icon: undefined, title: 'Local test' }, access: true },
			{ website: { websiteOrigin: 'example.test:443', icon: undefined, title: 'HTTP on TLS default port' }, access: true },
			{ website: { websiteOrigin: '', icon: undefined, title: 'Legacy file page' }, access: true },
			{ website: { websiteOrigin: 'https://already.example/path', icon: undefined, title: 'Canonical' }, access: true },
		]

		await migrateWebsiteAccess()

		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.websiteOrigin, 'example.com')
		assert.equal(storageState.websiteAccess[1]?.website.websiteOrigin, 'example.test:8080')
		assert.equal(storageState.websiteAccess[2]?.website.websiteOrigin, 'example.test:443')
		assert.equal(storageState.websiteAccess[3]?.website.websiteOrigin, '')
		assert.equal(storageState.websiteAccess[4]?.website.websiteOrigin, 'https://already.example')
	})

	test('removes malformed origins without preventing startup migration', async () => {
		const storageState = installBrowserMock()
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'https://', icon: undefined, title: 'Malformed scheme' }, access: true },
			{ website: { websiteOrigin: 'https://attacker.invalid@example.test/path', icon: undefined, title: 'Credentialed canonical URL' }, access: true },
			{ website: { websiteOrigin: 'example.com/path', icon: undefined, title: 'Malformed legacy host' }, access: true },
			{ website: { websiteOrigin: 'example.test', icon: undefined, title: 'Valid legacy host' }, access: true },
		]

		await migrateWebsiteAccess()

		assert.deepEqual(storageState.websiteAccess, [
			{ website: { websiteOrigin: 'example.test', icon: undefined, title: 'Valid legacy host' }, access: true },
		])
	})
})

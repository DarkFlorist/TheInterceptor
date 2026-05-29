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

async function withSilencedConsole<T>(runWithConsoleSilenced: () => Promise<T>) {
	const originalWarn = console.warn
	console.warn = () => undefined
	try {
		return await runWithConsoleSilenced()
	} finally {
		console.warn = originalWarn
	}
}

describe('address book migration', () => {
	test('migrates valid V1 entries through to V3', async () => {
		const storageState = installBrowserMock()
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		const legacyAddress = '0x0000000000000000000000000000000000000001'
		storageState.userAddressBookEntries = [{
			type: 'activeAddress',
			name: 'Legacy address',
			address: legacyAddress,
			askForAddressAccess: true,
			entrySource: 'User',
		}]

		await migrateAddressBook()

		assert.equal(storageState.userAddressBookEntries, undefined)
		assert.equal(storageState.userAddressBookEntriesV2, undefined)
		const migratedEntries = storageState.userAddressBookEntriesV3
		assert.ok(Array.isArray(migratedEntries))
		if (!Array.isArray(migratedEntries)) throw new Error('Expected migrated entries array')
		assert.equal(
			migratedEntries.some((entry) =>
				typeof entry === 'object'
				&& entry !== null
				&& 'type' in entry
				&& 'name' in entry
				&& 'address' in entry
				&& 'useAsActiveAddress' in entry
				&& 'chainId' in entry
				&& entry.type === 'contact'
				&& entry.name === 'Legacy address'
				&& entry.address === legacyAddress
				&& entry.useAsActiveAddress === true
				&& entry.chainId === 'AllChains'
			),
			true,
		)
	})

	test('clears corrupt V1 entries without failing migration', async () => {
		const storageState = installBrowserMock()
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		storageState.userAddressBookEntries = null

		await withSilencedConsole(async () => await migrateAddressBook())

		assert.equal(storageState.userAddressBookEntries, undefined)
	})

	test('clears corrupt V2 entries without failing migration', async () => {
		const storageState = installBrowserMock()
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		storageState.userAddressBookEntriesV2 = null

		await withSilencedConsole(async () => await migrateAddressBook())

		assert.equal(storageState.userAddressBookEntriesV2, undefined)
	})
})

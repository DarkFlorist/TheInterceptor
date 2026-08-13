import * as assert from 'assert'
import { describe, test } from 'bun:test'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock(onStorageSet: (() => void) | undefined = undefined) {
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
					onStorageSet?.()
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
	test('migrates a legacy Safe signer into simulation and owner metadata before schema parsing drops it', async () => {
		let storageSetCount = 0
		const storageState = installBrowserMock(() => { storageSetCount++ })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		const { getUserAddressBookEntries } = await import('../../app/ts/background/storageVariables.js')
		const legacySigner = '0x0000000000000000000000000000000000005678'
		storageState.userAddressBookEntriesV3 = [
			{
				type: 'safe',
				name: 'Legacy Safe',
				address: '0x0000000000000000000000000000000000001234',
				chainId: '0x1',
				entrySource: 'User',
				useAsActiveAddress: true,
				safeSignerAddress: legacySigner,
			},
			{
				type: 'ERC20',
				name: 'Repairable token',
				address: '0x0000000000000000000000000000000000009999',
				symbol: 'BAD',
				decimals: '0x100',
				entrySource: 'User',
			},
		]

		await migrateAddressBook()
		const writesAfterMigration = storageSetCount
		const entries = await getUserAddressBookEntries()

		assert.equal(entries[0]?.type, 'safe')
		if (entries[0]?.type !== 'safe') throw new Error('Expected migrated Safe entry')
		assert.equal(entries[0].safeSimulationSignerAddress, BigInt(legacySigner))
		assert.deepEqual(entries[0].safeSignerAddresses, [BigInt(legacySigner)])
		assert.equal(entries[1]?.type, 'contract')
		const storedEntries = storageState.userAddressBookEntriesV3
		assert.ok(Array.isArray(storedEntries))
		if (!Array.isArray(storedEntries) || typeof storedEntries[0] !== 'object' || storedEntries[0] === null) throw new Error('Expected serialized migrated Safe entry')
		assert.equal('safeSignerAddress' in storedEntries[0], false)
		assert.equal('safeSimulationSignerAddress' in storedEntries[0] && storedEntries[0].safeSimulationSignerAddress, legacySigner)
		assert.deepEqual('safeSignerAddresses' in storedEntries[0] && storedEntries[0].safeSignerAddresses, [legacySigner])
		assert.equal('safeSignerAddress' in entries[0], false)
		assert.equal(storageSetCount, writesAfterMigration)
	})

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

	test('preserves legacy Safe signer metadata while migrating V2 entries to V3', async () => {
		const storageState = installBrowserMock()
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		const legacySigner = '0x0000000000000000000000000000000000005678'
		storageState.userAddressBookEntriesV2 = [{
			type: 'safe',
			name: 'Legacy V2 Safe',
			address: '0x0000000000000000000000000000000000001234',
			chainId: '0x1',
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress: legacySigner,
		}]

		await migrateAddressBook()

		assert.equal(storageState.userAddressBookEntriesV2, undefined)
		const migratedEntries = storageState.userAddressBookEntriesV3
		assert.ok(Array.isArray(migratedEntries))
		if (!Array.isArray(migratedEntries) || typeof migratedEntries[0] !== 'object' || migratedEntries[0] === null) throw new Error('Expected migrated V2 Safe entry')
		assert.equal('safeSignerAddress' in migratedEntries[0], false)
		assert.equal('safeSimulationSignerAddress' in migratedEntries[0] && migratedEntries[0].safeSimulationSignerAddress, legacySigner)
		assert.deepEqual('safeSignerAddresses' in migratedEntries[0] && migratedEntries[0].safeSignerAddresses, [legacySigner])
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

	test('preserves valid V2 entries while repairing out-of-range ERC20 decimals', async () => {
		const storageState = installBrowserMock()
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		storageState.userAddressBookEntriesV2 = [
			{ type: 'contact', name: 'Preserved contact', address: '0x0000000000000000000000000000000000000001', entrySource: 'User' },
			{ type: 'ERC20', name: 'Invalid token', address: '0x0000000000000000000000000000000000000002', symbol: 'BAD', decimals: '0x100', entrySource: 'User' },
		]

		await migrateAddressBook()

		assert.equal(storageState.userAddressBookEntriesV2, undefined)
		const migratedEntries = storageState.userAddressBookEntriesV3
		assert.ok(Array.isArray(migratedEntries))
		if (!Array.isArray(migratedEntries)) throw new Error('Expected migrated entries array')
		assert.equal(migratedEntries.some((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && 'type' in entry && entry.name === 'Preserved contact' && entry.type === 'contact'), true)
		assert.equal(migratedEntries.some((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && 'type' in entry && entry.name === 'Invalid token' && entry.type === 'contract'), true)
	})
})

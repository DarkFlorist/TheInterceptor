import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('address book migration', () => {
	test('migrates a legacy Safe signer into simulation and owner metadata before schema parsing drops it', async () => {
		const legacySigner = '0x0000000000000000000000000000000000005678'
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntriesV3: [
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
		] } } })
		let storageSetCount = 0
		const storeItems = browserMock.browser.storage.local.set
		browserMock.browser.storage.local.set = async (items) => {
			storageSetCount++
			await storeItems(items)
		}
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')
		const { getUserAddressBookEntries } = await import('../../app/ts/background/storageVariables.js')

		await migrateAddressBook()
		const writesAfterMigration = storageSetCount
		const entries = await getUserAddressBookEntries()

		assert.equal(entries[0]?.type, 'safe')
		if (entries[0]?.type !== 'safe') throw new Error('Expected migrated Safe entry')
		assert.equal(entries[0].safeSimulationSignerAddress, BigInt(legacySigner))
		assert.deepEqual(entries[0].safeSignerAddresses, [BigInt(legacySigner)])
		assert.equal(entries[1]?.type, 'contract')
		const { userAddressBookEntriesV3: storedEntries } = browserMock.readStorage()
		assert.ok(Array.isArray(storedEntries))
		if (typeof storedEntries[0] !== 'object' || storedEntries[0] === null) throw new Error('Expected serialized migrated Safe entry')
		assert.equal('safeSignerAddress' in storedEntries[0], false)
		assert.equal('safeSimulationSignerAddress' in storedEntries[0] && storedEntries[0].safeSimulationSignerAddress, legacySigner)
		assert.deepEqual('safeSignerAddresses' in storedEntries[0] && storedEntries[0].safeSignerAddresses, [legacySigner])
		assert.equal('safeSignerAddress' in entries[0], false)
		assert.equal(storageSetCount, writesAfterMigration)
	})

	test('migrates valid V1 entries through to V3', async () => {
		const legacyAddress = '0x0000000000000000000000000000000000000001'
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntries: [{
			type: 'activeAddress',
			name: 'Legacy address',
			address: legacyAddress,
			askForAddressAccess: true,
			entrySource: 'User',
		}] } } })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')

		await migrateAddressBook()

		const { userAddressBookEntries, userAddressBookEntriesV2, userAddressBookEntriesV3: migratedEntries } = browserMock.readStorage()
		assert.equal(userAddressBookEntries, undefined)
		assert.equal(userAddressBookEntriesV2, undefined)
		assert.ok(Array.isArray(migratedEntries), 'Expected migrated entries array')
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
		const legacySigner = '0x0000000000000000000000000000000000005678'
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntriesV2: [{
			type: 'safe',
			name: 'Legacy V2 Safe',
			address: '0x0000000000000000000000000000000000001234',
			chainId: '0x1',
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress: legacySigner,
		}] } } })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')

		await migrateAddressBook()

		const { userAddressBookEntriesV2, userAddressBookEntriesV3: migratedEntries } = browserMock.readStorage()
		assert.equal(userAddressBookEntriesV2, undefined)
		assert.ok(Array.isArray(migratedEntries))
		if (typeof migratedEntries[0] !== 'object' || migratedEntries[0] === null) throw new Error('Expected migrated V2 Safe entry')
		assert.equal('safeSignerAddress' in migratedEntries[0], false)
		assert.equal('safeSimulationSignerAddress' in migratedEntries[0] && migratedEntries[0].safeSimulationSignerAddress, legacySigner)
		assert.deepEqual('safeSignerAddresses' in migratedEntries[0] && migratedEntries[0].safeSignerAddresses, [legacySigner])
	})

	test('clears corrupt V1 entries without failing migration', async () => {
		// Corrupt storage from older versions can hold null, which is what this test stores.
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntries: null } } })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')

		await withSilencedConsole(async () => await migrateAddressBook())

		assert.equal('userAddressBookEntries' in browserMock.readStorage(), false)
	})

	test('clears corrupt V2 entries without failing migration', async () => {
		// Corrupt storage from older versions can hold null, which is what this test stores.
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntriesV2: null } } })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')

		await withSilencedConsole(async () => await migrateAddressBook())

		assert.equal('userAddressBookEntriesV2' in browserMock.readStorage(), false)
	})

	test('preserves valid V2 entries while repairing out-of-range ERC20 decimals', async () => {
		const browserMock = installBrowserMock({ storage: { local: { userAddressBookEntriesV2: [
			{ type: 'contact', name: 'Preserved contact', address: '0x0000000000000000000000000000000000000001', entrySource: 'User' },
			{ type: 'ERC20', name: 'Invalid token', address: '0x0000000000000000000000000000000000000002', symbol: 'BAD', decimals: '0x100', entrySource: 'User' },
		] } } })
		const { migrateAddressBook } = await import('../../app/ts/background/addressBookMigration.js')

		await migrateAddressBook()

		const { userAddressBookEntriesV2, userAddressBookEntriesV3: migratedEntries } = browserMock.readStorage()
		assert.equal(userAddressBookEntriesV2, undefined)
		assert.ok(Array.isArray(migratedEntries), 'Expected migrated entries array')
		assert.equal(migratedEntries.some((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && 'type' in entry && entry.name === 'Preserved contact' && entry.type === 'contact'), true)
		assert.equal(migratedEntries.some((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && 'type' in entry && entry.name === 'Invalid token' && entry.type === 'contract'), true)
	})
})

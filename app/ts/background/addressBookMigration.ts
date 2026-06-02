import * as funtypes from 'funtypes'
import { type AddressBookEntries, type AddressBookEntry, AddressBookEntries as AddressBookEntriesRuntype, AddressBookEntry as AddressBookEntryRuntype } from '../types/addressBookTypes.js'
import { type OldActiveAddressEntry, OldActiveAddressEntry as OldActiveAddressEntryRuntype, browserStorageLocalRemove } from '../utils/storageUtils.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { updateUserAddressBookEntries, updateUserAddressBookEntriesV2Old } from './storageVariables.js'

const LegacyAddressBookEntriesV1 = funtypes.ReadonlyArray(funtypes.Union(AddressBookEntryRuntype, OldActiveAddressEntryRuntype))

async function getLegacyAddressBookEntriesV1ForMigration(): Promise<readonly (AddressBookEntry | OldActiveAddressEntry)[] | undefined> {
	const storageEntries: Partial<Record<'userAddressBookEntries', unknown>> = await browser.storage.local.get('userAddressBookEntries')
	const rawEntries = storageEntries.userAddressBookEntries
	if (rawEntries === undefined) return undefined
	const parsedEntries = LegacyAddressBookEntriesV1.safeParse(rawEntries)
	if (parsedEntries.success) return parsedEntries.value
	console.warn('userAddressBookEntries was corrupt during migration:')
	console.warn(rawEntries)
	await browserStorageLocalRemove(['userAddressBookEntries'])
	return undefined
}

async function getLegacyAddressBookEntriesV2ForMigration(): Promise<AddressBookEntries | undefined> {
	const storageEntries: Partial<Record<'userAddressBookEntriesV2', unknown>> = await browser.storage.local.get('userAddressBookEntriesV2')
	const rawEntries = storageEntries.userAddressBookEntriesV2
	if (rawEntries === undefined) return undefined
	const parsedEntries = AddressBookEntriesRuntype.safeParse(rawEntries)
	if (parsedEntries.success) return parsedEntries.value
	console.warn('userAddressBookEntriesV2 was corrupt during migration:')
	console.warn(rawEntries)
	await browserStorageLocalRemove(['userAddressBookEntriesV2'])
	return undefined
}

async function migrateAddressInfoAndContactsFromV1ToV2() {
	const userAddressBookEntries = await getLegacyAddressBookEntriesV1ForMigration()
	const convertOldActiveAddressToAddressBookEntry = (entry: AddressBookEntry | OldActiveAddressEntry): AddressBookEntry => {
		if (entry.type !== 'activeAddress') return entry
		return { ...entry, type: 'contact', useAsActiveAddress: true }
	}
	if (userAddressBookEntries === undefined) return
	const updated: AddressBookEntries = userAddressBookEntries.map(convertOldActiveAddressToAddressBookEntry)
	if (updated.length > 0) {
		await updateUserAddressBookEntriesV2Old((previousEntries) => getUniqueItemsByProperties(updated.concat(previousEntries), ['address']))
		await browserStorageLocalRemove(['userAddressBookEntries'])
	}
}

async function migrateAddressInfoAndContactsFromV2ToV3() {
	const userAddressBookEntries = await getLegacyAddressBookEntriesV2ForMigration()
	const convertOldActiveAddressToAddressBookEntry = (entry: AddressBookEntry): AddressBookEntry => {
		if (entry.chainId !== undefined) return entry
		if (entry.useAsActiveAddress === true && entry.type === 'contact') return { ...entry, chainId: 'AllChains' }
		return { ...entry, chainId: 1n }
	}
	if (userAddressBookEntries === undefined) return
	const updated: AddressBookEntries = userAddressBookEntries.map(convertOldActiveAddressToAddressBookEntry)
	if (updated.length > 0) {
		await updateUserAddressBookEntries((previousEntries) => getUniqueItemsByProperties(updated.concat(previousEntries), ['address', 'chainId']))
		await browserStorageLocalRemove(['userAddressBookEntriesV2'])
	}
}

export async function migrateAddressBook() {
	await migrateAddressInfoAndContactsFromV1ToV2()
	await migrateAddressInfoAndContactsFromV2ToV3()
}

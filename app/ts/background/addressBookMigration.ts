import { type AddressBookEntries, type AddressBookEntry, SafeEntry } from '../types/addressBookTypes.js'
import { EthereumAddress } from '../types/wire-types.js'
import { type OldActiveAddressEntry, OldActiveAddressEntry as OldActiveAddressEntryRuntype, browserStorageLocalRemove, browserStorageLocalSet } from '../utils/storageUtils.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { repairLegacyAddressBookEntries, repairLegacyAddressBookEntry, updateUserAddressBookEntries, updateUserAddressBookEntriesV2Old } from './storageVariables.js'

async function getLegacyAddressBookEntriesV1ForMigration(): Promise<readonly (AddressBookEntry | OldActiveAddressEntry)[] | undefined> {
	const storageEntries: Partial<Record<'userAddressBookEntries', unknown>> = await browser.storage.local.get('userAddressBookEntries')
	const rawEntries = storageEntries.userAddressBookEntries
	if (rawEntries === undefined) return undefined
	if (Array.isArray(rawEntries)) {
		const parsedEntries = rawEntries.map((rawEntry) => {
			const oldActiveAddress = OldActiveAddressEntryRuntype.safeParse(rawEntry)
			return oldActiveAddress.success ? oldActiveAddress.value : repairLegacyAddressBookEntry(rawEntry)
		})
		if (parsedEntries.every((entry) => entry !== undefined)) return parsedEntries.filter((entry): entry is AddressBookEntry | OldActiveAddressEntry => entry !== undefined)
	}
	console.warn('userAddressBookEntries was corrupt during migration:')
	console.warn(rawEntries)
	await browserStorageLocalRemove(['userAddressBookEntries'])
	return undefined
}

async function getLegacyAddressBookEntriesV2ForMigration(): Promise<AddressBookEntries | undefined> {
	const storageEntries: Partial<Record<'userAddressBookEntriesV2', unknown>> = await browser.storage.local.get('userAddressBookEntriesV2')
	const rawEntries = storageEntries.userAddressBookEntriesV2
	if (rawEntries === undefined) return undefined
	const entriesWithMigratedSafeSigners = migrateLegacySafeAddressBookEntries(rawEntries)
	if (entriesWithMigratedSafeSigners !== undefined) return entriesWithMigratedSafeSigners
	const parsedEntries = repairLegacyAddressBookEntries(rawEntries)
	if (parsedEntries !== undefined) return parsedEntries
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

export function migrateLegacySafeAddressBookEntries(rawEntries: unknown): AddressBookEntries | undefined {
	if (!Array.isArray(rawEntries)) return undefined
	let migrationNeeded = false
	const migratedEntries: AddressBookEntry[] = []
	for (const rawEntry of rawEntries) {
		const isLegacySafe = typeof rawEntry === 'object'
			&& rawEntry !== null
			&& 'type' in rawEntry
			&& rawEntry.type === 'safe'
			&& 'safeSignerAddress' in rawEntry
		if (!isLegacySafe) {
			const repairedEntry = repairLegacyAddressBookEntry(rawEntry)
			if (repairedEntry === undefined) return undefined
			migratedEntries.push(repairedEntry)
			continue
		}
		migrationNeeded = true
		const parsedSafe = SafeEntry.safeParse(rawEntry)
		const parsedLegacySigner = EthereumAddress.safeParse(rawEntry.safeSignerAddress)
		if (!parsedSafe.success || !parsedLegacySigner.success) return undefined
		const legacySigner = parsedLegacySigner.value
		migratedEntries.push({
			...parsedSafe.value,
			safeSimulationSignerAddress: parsedSafe.value.safeSimulationSignerAddress ?? legacySigner,
			safeSignerAddresses: Array.from(new Set([...(parsedSafe.value.safeSignerAddresses ?? []), legacySigner])),
		})
	}
	return migrationNeeded ? migratedEntries : undefined
}

async function migrateLegacySafeSignerFieldInV3() {
	const { userAddressBookEntriesV3: rawEntries } = await browser.storage.local.get('userAddressBookEntriesV3')
	const migratedEntries = migrateLegacySafeAddressBookEntries(rawEntries)
	if (migratedEntries === undefined) return
	await browserStorageLocalSet({ userAddressBookEntriesV3: migratedEntries })
}

export async function migrateAddressBook() {
	await migrateAddressInfoAndContactsFromV1ToV2()
	await migrateLegacySafeSignerFieldInV3()
	await migrateAddressInfoAndContactsFromV2ToV3()
}

import { AddressBookEntry, LegacyErc20TokenEntry, doAddressBookChainIdsMatch, type AddressBookEntries, type ChainIdWithUniversal, type SafeEntry } from '../types/addressBookTypes.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

export function repairLegacyAddressBookEntry(rawEntry: unknown): AddressBookEntry | undefined {
	const parsedEntry = AddressBookEntry.safeParse(rawEntry)
	if (parsedEntry.success) return parsedEntry.value
	const legacyErc20Entry = LegacyErc20TokenEntry.safeParse(rawEntry)
	if (!legacyErc20Entry.success || isValidErc20Decimals(legacyErc20Entry.value.decimals)) return undefined
	const { decimals: _decimals, symbol: _symbol, type: _type, ...contractFields } = legacyErc20Entry.value
	return { ...contractFields, type: 'contract' }
}

export function repairLegacyAddressBookEntries(rawEntries: unknown): AddressBookEntries | undefined {
	if (!Array.isArray(rawEntries)) return undefined
	const repairedEntries = rawEntries.map(repairLegacyAddressBookEntry)
	if (repairedEntries.some((entry) => entry === undefined)) return undefined
	return repairedEntries.filter((entry): entry is AddressBookEntry => entry !== undefined)
}

export async function getUserAddressBookEntries(): Promise<AddressBookEntries> {
	const { userAddressBookEntriesV3: rawEntries } = await browser.storage.local.get('userAddressBookEntriesV3')
	const parsedEntries = await browserStorageLocalSafeParseGet('userAddressBookEntriesV3')
	if (parsedEntries?.userAddressBookEntriesV3 !== undefined) return parsedEntries.userAddressBookEntriesV3
	if (rawEntries === undefined) return DEFAULT_ACTIVE_ADDRESSES
	const repairedEntries = repairLegacyAddressBookEntries(rawEntries)
	if (repairedEntries !== undefined) {
		await browserStorageLocalSet({ userAddressBookEntriesV3: repairedEntries })
		return repairedEntries
	}
	console.warn('userAddressBookEntriesV3 was corrupt:')
	console.warn(rawEntries)
	await browserStorageLocalSet({ userAddressBookEntriesV3: DEFAULT_ACTIVE_ADDRESSES })
	return DEFAULT_ACTIVE_ADDRESSES
}
export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => getAddressBookEntriesForChainIdMorePreciseFirst(await getUserAddressBookEntries(), chainId)

export const userAddressBookEntriesStorageWrite = (userAddressBookEntriesV3: AddressBookEntries): StorageWrite => ({ userAddressBookEntriesV3 })

// The fields of a saved Safe that do not identify it. Which entries exist, and their types and addresses, decide which ordinary addresses may keep a signing wallet, so this type leaves them out.
export type SafeEntryDetails = Omit<SafeEntry, 'type' | 'address' | 'chainId'>

/** Caches an address identified from bundled or on-chain metadata unless the address book already has an entry for it on that chain. The entry cannot be a Safe, so it cannot exclude an address from signing; and stored bindings only belong to eligible addresses (see pruneIneligibleSigningWalletBindings), so no stored binding waits for a newly added address. The addition therefore leaves signing wallet eligibility unchanged and needs no signing storage. */
export async function addAddressBookEntryIfMissing(newEntry: Exclude<AddressBookEntry, SafeEntry>) {
	await runSettingsStorageTransaction(async () => {
		const entries = await getUserAddressBookEntries()
		if (entries.some((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))) return { writes: [], result: undefined }
		return { writes: [userAddressBookEntriesStorageWrite([...entries, newEntry])], result: undefined }
	})
}

/** The other address-book write outside signingAddressBookCoordinator: it changes details of one saved Safe and cannot add, remove or reclassify an entry, so signing wallet eligibility stays the same. Every other edit goes through updateAddressBookAndSigningWalletBindings. Returns the updated Safe, or undefined when it is no longer saved. */
export async function updateSafeAddressBookEntryDetails(chainId: bigint, address: bigint, update: (details: SafeEntryDetails) => SafeEntryDetails) {
	return await runSettingsStorageTransaction(async () => {
		let updated: SafeEntry | undefined
		const entries = (await getUserAddressBookEntries()).map((entry) => {
			if (entry.type !== 'safe' || entry.address !== address || entry.chainId !== chainId) return entry
			const { type, address: safeAddress, chainId: safeChainId, ...details } = entry
			updated = { ...update(details), type, address: safeAddress, chainId: safeChainId }
			return updated
		})
		return { writes: updated === undefined ? [] : [userAddressBookEntriesStorageWrite(entries)], result: updated }
	})
}

export async function updateUserAddressBookEntriesV2Old(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await runSettingsStorageTransaction(async () => {
		const entries = (await browserStorageLocalGet('userAddressBookEntriesV2')).userAddressBookEntriesV2 ?? DEFAULT_ACTIVE_ADDRESSES
		return { writes: [{ userAddressBookEntriesV2: updateFunc(entries) }], result: undefined }
	})
}

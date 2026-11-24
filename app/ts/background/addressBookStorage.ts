import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { AddressBookEntry, LegacyErc20TokenEntry, type AddressBookEntries, type ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import type { StorageWrite } from './settingsStorageTransaction.js'

// Address-book persistence only: reading, legacy repair and the storage-write builder. It knows nothing about rich mode; addressBookCoordinator composes its writes with funding reconciliation.
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

// The stored address book as it should be read: valid, missing (the defaults), repaired from legacy ERC-20 entries, or corrupt (the defaults). Reading never writes; the coordinator's persistRepairedUserAddressBookEntries persists a repaired or fallback view.
export async function readStoredUserAddressBookEntries(): Promise<{ readonly state: 'valid' | 'missing' | 'repaired' | 'corrupt', readonly entries: AddressBookEntries, readonly rawEntries: unknown }> {
	const { userAddressBookEntriesV3: rawEntries } = await browser.storage.local.get('userAddressBookEntriesV3')
	const parsedEntries = await browserStorageLocalSafeParseGet('userAddressBookEntriesV3')
	if (parsedEntries?.userAddressBookEntriesV3 !== undefined) return { state: 'valid', entries: parsedEntries.userAddressBookEntriesV3, rawEntries }
	if (rawEntries === undefined) return { state: 'missing', entries: DEFAULT_ACTIVE_ADDRESSES, rawEntries }
	const repairedEntries = repairLegacyAddressBookEntries(rawEntries)
	return repairedEntries === undefined ? { state: 'corrupt', entries: DEFAULT_ACTIVE_ADDRESSES, rawEntries } : { state: 'repaired', entries: repairedEntries, rawEntries }
}

export async function getUserAddressBookEntries(): Promise<AddressBookEntries> {
	return (await readStoredUserAddressBookEntries()).entries
}

export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => getAddressBookEntriesForChainIdMorePreciseFirst(await getUserAddressBookEntries(), chainId)

// The storage items that replace the stored address book with entries. Only addressBookCoordinator calls this, inside a settings storage transaction that also writes the rich-mode funding reconciled with the entries.
export const userAddressBookEntriesStorageWrite = (userAddressBookEntriesV3: AddressBookEntries): StorageWrite => ({ userAddressBookEntriesV3 })

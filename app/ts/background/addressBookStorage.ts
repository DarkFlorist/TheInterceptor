import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import { AddressBookEntry, doAddressBookChainIdsMatch, LegacyErc20TokenEntry, type AddressBookEntries, type ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { richFundingSaved, type RichFundingResult, type RichModeState } from '../types/richMode.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { getRichModeWritesForAddressBook } from './richModeSettings.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

// The only owner of address-book storage. Every address-book write goes through updateUserAddressBookEntries, replaceUserAddressBookEntries or getImportedAddressBookStorageWrites, which reconcile rich-mode funding in the same storage set; the raw write stays private here.
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

// The stored address book as it should be read: valid, missing (the defaults), repaired from legacy ERC-20 entries, or corrupt (the defaults). Reading never writes; persistRepairedUserAddressBookEntries persists a repaired or fallback view.
async function readStoredUserAddressBookEntries(): Promise<{ readonly state: 'valid' | 'missing' | 'repaired' | 'corrupt', readonly entries: AddressBookEntries, readonly rawEntries: unknown }> {
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

// Persists the repaired or fallback view of a stored address book that does not parse, through the reconciling write, so funding that referenced a repaired token is reconciled in the same storage write. Runs from the startup address-book migration.
export async function persistRepairedUserAddressBookEntries() {
	await runSettingsStorageTransaction(async () => {
		const stored = await readStoredUserAddressBookEntries()
		if (stored.state === 'valid' || stored.state === 'missing') return { writes: [], result: undefined }
		if (stored.state === 'corrupt') {
			console.warn('userAddressBookEntriesV3 was corrupt:')
			console.warn(stored.rawEntries)
		}
		return { writes: (await getFundingAwareAddressBookWrites(undefined, stored.entries)).writes, result: undefined }
	})
}

export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => getAddressBookEntriesForChainIdMorePreciseFirst(await getUserAddressBookEntries(), chainId)

const userAddressBookEntriesStorageWrite = (userAddressBookEntriesV3: AddressBookEntries): StorageWrite => ({ userAddressBookEntriesV3 })

// The address-book writes for entries, plus the funding writes that keep rich mode consistent with them. Must run inside a settings storage transaction. An update that returns the previous array writes no address book but still reconciles funding.
async function getFundingAwareAddressBookWrites(previous: AddressBookEntries | undefined, entries: AddressBookEntries, importedRichModeState?: RichModeState) {
	const funding = await getRichModeWritesForAddressBook(entries, importedRichModeState)
	return { writes: [...entries === previous ? [] : [userAddressBookEntriesStorageWrite(entries)], ...funding.writes], fundingChanged: funding.fundingChanged }
}

export async function updateUserAddressBookEntries(update: (entries: AddressBookEntries) => AddressBookEntries): Promise<RichFundingResult> {
	return await runSettingsStorageTransaction(async () => {
		const previous = await getUserAddressBookEntries()
		const { writes, fundingChanged } = await getFundingAwareAddressBookWrites(previous, update(previous))
		return { writes, result: richFundingSaved(fundingChanged) }
	})
}

// Replaces the stored entries without reading them first, for migrations whose stored value does not parse yet.
export async function replaceUserAddressBookEntries(entries: AddressBookEntries): Promise<RichFundingResult> {
	return await runSettingsStorageTransaction(async () => {
		const { writes, fundingChanged } = await getFundingAwareAddressBookWrites(undefined, entries)
		return { writes, result: richFundingSaved(fundingChanged) }
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	return await updateUserAddressBookEntries((entries) => entries.some((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId)) ? entries : entries.concat(newEntry))
}

// The settings import writes imported entries and imported funding, reconciled against them, inside its own storage transaction.
export async function getImportedAddressBookStorageWrites(entries: AddressBookEntries, importedRichModeState: RichModeState) {
	return (await getFundingAwareAddressBookWrites(undefined, entries, importedRichModeState)).writes
}

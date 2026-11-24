import { AddressBookEntries as AddressBookEntriesCodec, doAddressBookChainIdsMatch, type AddressBookEntries, type AddressBookEntry } from '../types/addressBookTypes.js'
import { richFundingSaved, type RichFundingResult, type RichModeState } from '../types/richMode.js'
import { getUserAddressBookEntries, readStoredUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './addressBookStorage.js'
import { backgroundTaskSupervisor } from './backgroundTasks.js'
import { getRichModeWritesForAddressBook } from './richModeSettings.js'
import { isStoredValueChanged, runSettingsStorageTransaction } from './settingsStorageTransaction.js'

// Coordinates the address-book and rich-mode owners: every address-book write lands together with the funding reconciled against it, in one settings storage set. This is the only module that calls the address-book write builder.

// The address-book writes for entries plus the funding writes that keep rich mode consistent with them. Must run inside a settings storage transaction. Entries equal in value to previous (by the same serialized comparison rich-mode state uses) write no address book but still reconcile funding; without previous they are always written.
async function getCoordinatedAddressBookWrites(previous: AddressBookEntries | undefined, entries: AddressBookEntries, importedRichModeState?: RichModeState) {
	const funding = await getRichModeWritesForAddressBook(entries, importedRichModeState)
	const addressBookChanged = previous === undefined || isStoredValueChanged(AddressBookEntriesCodec, previous, entries)
	return { writes: [...addressBookChanged ? [userAddressBookEntriesStorageWrite(entries)] : [], ...funding.writes], fundingChanged: funding.fundingChanged }
}

export async function updateUserAddressBookEntries(update: (entries: AddressBookEntries) => AddressBookEntries): Promise<RichFundingResult> {
	return await runSettingsStorageTransaction(async () => {
		const previous = await getUserAddressBookEntries()
		const { writes, fundingChanged } = await getCoordinatedAddressBookWrites(previous, update(previous))
		return { writes, result: richFundingSaved(fundingChanged) }
	})
}

// Replaces the stored entries without reading them first, for migrations whose stored value does not parse yet.
export async function replaceUserAddressBookEntries(entries: AddressBookEntries): Promise<RichFundingResult> {
	return await runSettingsStorageTransaction(async () => {
		const { writes, fundingChanged } = await getCoordinatedAddressBookWrites(undefined, entries)
		return { writes, result: richFundingSaved(fundingChanged) }
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	return await updateUserAddressBookEntries((entries) => entries.some((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId)) ? entries : entries.concat(newEntry))
}

// Persists the repaired or fallback view of a stored address book that does not parse, with the funding a repaired token invalidates, in one storage write. Runs from the startup address-book migration.
export async function persistRepairedUserAddressBookEntries() {
	await runSettingsStorageTransaction(async () => {
		const stored = await readStoredUserAddressBookEntries()
		if (stored.state === 'valid' || stored.state === 'missing') return { writes: [], result: undefined }
		if (stored.state === 'corrupt') {
			console.warn('userAddressBookEntriesV3 was corrupt:')
			console.warn(stored.rawEntries)
		}
		return { writes: (await getCoordinatedAddressBookWrites(undefined, stored.entries)).writes, result: undefined }
	})
}

// The settings import writes imported entries and imported funding, reconciled against them, inside its own storage transaction.
export async function getImportedAddressBookStorageWrites(entries: AddressBookEntries, importedRichModeState: RichModeState) {
	return (await getCoordinatedAddressBookWrites(undefined, entries, importedRichModeState)).writes
}

// A user-facing address-book edit: written like every address-book write, then, when funding changed, refreshSimulation runs as a background task so edits do not wait for RPC work. The caller supplies the refresh because the simulation layer itself reads the address book through this module. Used by the address-book editor and watch-asset approvals.
export async function updateAddressBookAndRefreshChangedFunding(refreshSimulation: () => Promise<void>, update: (entries: AddressBookEntries) => AddressBookEntries) {
	const result = await updateUserAddressBookEntries(update)
	if (result.ok && result.fundingChanged) backgroundTaskSupervisor.start({ source: 'address_book_funding_refresh' }, refreshSimulation)
	return result
}

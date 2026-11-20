import { type AddressBookEntries, type AddressBookEntry, doAddressBookChainIdsMatch } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { commitBrowserStorageLocalWrite } from '../utils/storageUtils.js'
import type { AddressBookStorageItems } from '../types/addressBookStorage.js'

// Background-only revision of edited/imported names. Universal addresses and ENS names can affect multiple chains, so edits conservatively share a revision; identification-cache fills do not advance it.
let addressBookRevision = 0
const addressBookRevisionSemaphore = new Semaphore(1)

export const getAddressBookRevision = () => addressBookRevision
export const getSettledAddressBookRevision = async () => await addressBookRevisionSemaphore.execute(async () => addressBookRevision)

// Explicit commit boundary for name edits: a settled read cannot fall between persistence and its revision, and failed writes do not advance it.
export async function recordAddressBookWrite(write: () => Promise<void>) {
	await addressBookRevisionSemaphore.execute(async () => {
		await write()
		addressBookRevision += 1
	})
}

export const writeAddressBookStorage = async (items: AddressBookStorageItems) => await recordAddressBookWrite(async () => await commitBrowserStorageLocalWrite(items))

// Only the name-store owner constructs this descriptor. A settings transaction receives data and a revision effect, never an arbitrary callback around unrelated keys.
const addressBookWriteData: unique symbol = Symbol('address book write')
export type AddressBookStorageWrite = { readonly [addressBookWriteData]: { readonly items: AddressBookStorageItems, readonly advancesRevision: boolean } }
export const prepareAddressBookWrite = (items: AddressBookStorageItems): AddressBookStorageWrite => ({ [addressBookWriteData]: { items, advancesRevision: true } })
export const isAddressBookStorageWrite = (write: object): write is AddressBookStorageWrite => addressBookWriteData in write
export const getAddressBookStorageWrite = (write: AddressBookStorageWrite) => write[addressBookWriteData]

// A cache plan can only append one missing identification, never replace a name. The storage owner supplies entries read under the settings transaction lock.
export function prepareAddressIdentificationInsertion(entries: AddressBookEntries, newEntry: AddressBookEntry): AddressBookStorageWrite | undefined {
	if (entries.some((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))) return undefined
	return { [addressBookWriteData]: { items: { userAddressBookEntriesV3: entries.concat(newEntry) }, advancesRevision: false } }
}

// Repair-on-read normalizes the values the reader is about to use; it is not a separately published edit made during that reader's run.
export const persistAddressBookReadRepair = async (entries: AddressBookEntries) => await commitBrowserStorageLocalWrite({ userAddressBookEntriesV3: entries })

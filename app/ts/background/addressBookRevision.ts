import { type AddressBookEntries, type AddressBookEntry, doAddressBookChainIdsMatch } from '../types/addressBookTypes.js'
import type { ENSNameHashes, ENSLabelHashes } from '../types/ens.js'
import { keccak256, namehash, stringToBytes } from '../utils/ethereumPrimitives.js'
import { Semaphore } from '../utils/semaphore.js'
import { commitBrowserStorageLocalWrite, type GeneralStorageItems, type LocalStorageItems } from '../utils/storageUtils.js'
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

// Only this owner can assign a write's revision policy; callers cannot classify an arbitrary replacement as a cache fill.
const addressBookWriteData: unique symbol = Symbol('address book write')
export type AddressBookStorageWrite = {
	readonly [addressBookWriteData]: { readonly items: AddressBookStorageItems, readonly policy: 'edit' | 'cache-insertion' }
}
const isAddressBookStorageWrite = (write: object): write is AddressBookStorageWrite => addressBookWriteData in write
const getAddressBookWriteItems = (write: AddressBookStorageWrite) => write[addressBookWriteData].items
const addressBookWriteChangesNames = (write: AddressBookStorageWrite) => write[addressBookWriteData].policy === 'edit'
export const prepareAddressBookWrite = (items: AddressBookStorageItems): AddressBookStorageWrite => ({ [addressBookWriteData]: { items, policy: 'edit' } })

// Mixed settings writes commit atomically, but only this domain owner interprets name-edit policy and advances its revision.
export async function commitSettingsWritesWithAddressBookRevision(writes: readonly (GeneralStorageItems | AddressBookStorageWrite)[]) {
	if (writes.length === 0) return
	const items = writes.reduce<LocalStorageItems>((items, write) => ({ ...items, ...(isAddressBookStorageWrite(write) ? getAddressBookWriteItems(write) : write) }), {})
	const commit = async () => await commitBrowserStorageLocalWrite(items)
	if (writes.some((write) => isAddressBookStorageWrite(write) && addressBookWriteChangesNames(write))) await recordAddressBookWrite(commit)
	else await commit()
}

// A cache plan can only append one missing identification, never replace a name. The storage owner supplies entries read under the settings transaction lock.
export function prepareAddressIdentificationInsertion(entries: AddressBookEntries, newEntry: AddressBookEntry): AddressBookStorageWrite | undefined {
	if (entries.some((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))) return undefined
	return { [addressBookWriteData]: { items: { userAddressBookEntriesV3: entries.concat(newEntry) }, policy: 'cache-insertion' } }
}

// Repair-on-read normalizes the values the reader is about to use; it is not a separately published edit made during that reader's run.
export const persistAddressBookReadRepair = async (entries: AddressBookEntries) => await commitBrowserStorageLocalWrite({ userAddressBookEntriesV3: entries })

// Lookup caches only append a missing hash/name pair. Explicit ENS edits use the revision-bearing writer; these operations cannot replace a cached name.
export async function persistEnsNodeHashCache(previous: ENSNameHashes, name: string) {
	const entry = { name, nameHash: BigInt(namehash(name)) }
	if (previous.some((old) => old.nameHash === entry.nameHash)) return
	await commitBrowserStorageLocalWrite({ ensNameHashes: [...previous, entry] })
}

export async function persistEnsLabelHashCache(previous: ENSLabelHashes, label: string) {
	const entry = { label, labelHash: BigInt(keccak256(stringToBytes(label))) }
	if (previous.some((old) => old.labelHash === entry.labelHash)) return
	await commitBrowserStorageLocalWrite({ ensLabelHashes: [...previous, entry] })
}

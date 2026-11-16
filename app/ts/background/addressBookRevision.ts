import { Semaphore } from '../utils/semaphore.js'
import { commitBrowserStorageLocalWrite } from '../utils/storageUtils.js'
import type { AddressBookStorageItems } from '../types/addressBookStorage.js'

// Background-only revision of edited/imported/repaired names. Universal addresses and ENS names can affect multiple chains, so edits conservatively share a revision; identification-cache fills do not advance it.
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

// Transaction plans carry the domain effect with the payload, rather than inferring it from storage keys at commit time.
export type AddressBookStorageWrite = {
	readonly addressBookWrite: AddressBookStorageItems
	readonly change: 'names-changed' | 'identification-cache-filled'
}
export const addressBookStorageWrite = (addressBookWrite: AddressBookStorageItems): AddressBookStorageWrite => ({ addressBookWrite, change: 'names-changed' })
export const identificationCacheStorageWrite = (addressBookWrite: AddressBookStorageItems): AddressBookStorageWrite => ({ addressBookWrite, change: 'identification-cache-filled' })

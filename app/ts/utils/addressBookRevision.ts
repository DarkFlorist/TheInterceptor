import { Semaphore } from './semaphore.js'
import type { LocalStorageKey } from './storageUtils.js'

// Name stores read by address identification. Add new stores here and write them through browserStorageLocalSet, including imports and repairs, so an in-flight confirmation catches up after the commit.
export const ADDRESS_IDENTIFICATION_STORAGE_KEYS: readonly LocalStorageKey[] = ['userAddressBookEntriesV3', 'ensNameHashes', 'ensLabelHashes']

// Tracks persisted address-book and ENS names in this background lifetime. The shared storage setter applies this module's key policy to revision updates, including atomic settings imports, repairs and cached identifications.
let addressBookRevision = 0
const addressBookRevisionSemaphore = new Semaphore(1)

export const getAddressBookRevision = () => addressBookRevision
export const getSettledAddressBookRevision = async () => await addressBookRevisionSemaphore.execute(async () => addressBookRevision)

// A settled read cannot fall between the storage commit and its revision update. Failed writes do not advance the revision.
export async function withAddressBookRevisionUpdate(write: () => Promise<void>) {
	await addressBookRevisionSemaphore.execute(async () => {
		await write()
		addressBookRevision += 1
	})
}

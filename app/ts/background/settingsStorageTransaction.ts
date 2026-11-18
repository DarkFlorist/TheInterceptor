import { browserStorageLocalSet, type GenericStorageItems } from '../utils/storageUtils.js'
import { createStorageTransactionRunner } from './storageTransaction.js'

// The items one storage owner writes for its own keys, built by that owner's …StorageWrite function so each key, value transform and sanitization stays with its owner.
export type StorageWrite = GenericStorageItems

// Runs plan under the one lock of every read-modify-write of website access, signing address preferences and the address book, including the settings import that replaces all three, and applies every write it returns in a single storage set; with a single lock there is no acquisition order between them to get wrong.
export const runSettingsStorageTransaction = createStorageTransactionRunner<StorageWrite>(async (writes) => {
	await browserStorageLocalSet(writes.reduce<StorageWrite>((items, write) => ({ ...items, ...write }), {}))
})

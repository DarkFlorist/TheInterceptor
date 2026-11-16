import { Semaphore } from '../utils/semaphore.js'
import { commitBrowserStorageLocalWrite, type GeneralStorageItems, type LocalStorageItems } from '../utils/storageUtils.js'
import { recordAddressBookWrite, type AddressBookStorageWrite } from './addressBookRevision.js'

// The items one storage owner writes for its own keys, built by that owner's …StorageWrite function so each key, value transform and sanitization stays with its owner.
export type StorageWrite = GeneralStorageItems

const isAddressBookWrite = (write: StorageWrite | AddressBookStorageWrite): write is AddressBookStorageWrite => 'addressBookWrite' in write

type StorageTransactionPlan<Result> = { readonly writes: readonly (StorageWrite | AddressBookStorageWrite)[], readonly result: Result }

// The one lock of every read-modify-write of website access, signing address preferences and the address book, including the settings import that replaces all three; with a single lock there is no acquisition order between them to get wrong.
const settingsStorageLock = new Semaphore(1)

// Runs plan under the settings storage lock and applies every write it returns in a single storage set, so the writes land together or not at all. plan must only read storage: starting another transaction inside it would wait for this lock forever.
export async function runSettingsStorageTransaction<Result>(plan: () => Promise<StorageTransactionPlan<Result>>) {
	return await settingsStorageLock.execute(async () => {
		const { writes, result } = await plan()
		if (writes.length > 0) {
			const items = writes.reduce<LocalStorageItems>((items, write) => ({ ...items, ...(isAddressBookWrite(write) ? write.addressBookWrite : write) }), {})
			const commit = async () => await commitBrowserStorageLocalWrite(items)
			if (writes.some((write) => isAddressBookWrite(write) && write.change === 'names-changed')) await recordAddressBookWrite(commit)
			else await commit()
		}
		return result
	})
}

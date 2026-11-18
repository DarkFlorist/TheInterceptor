import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet, type LocalStorageItems, type WritableLocalStorageItems } from '../utils/storageUtils.js'

// The items one storage owner writes for its own keys, built by that owner's …StorageWrite function so each key, value transform and sanitization stays with its owner. The active network is not one of them: only writeActiveNetwork in the background-only activeNetworkStorage.ts writes it, so this module, which page contexts reach through storageVariables.ts, never imports that writer.
export type StorageWrite = WritableLocalStorageItems

type StorageTransactionPlan<Result, Write> = { readonly writes: readonly Write[], readonly result: Result }

// The one lock of every read-modify-write of website access, signing address preferences and the address book, including the settings import that replaces all three; with a single lock there is no acquisition order between them to get wrong.
const settingsStorageLock = new Semaphore(1)

// Runs plan under the settings storage lock and applies every write it returns in a single storage set through write, so the writes land together or not at all. plan must only read storage: starting another transaction inside it would wait for this lock forever. A background caller whose writes include the active network, such as the settings import, passes writeLocalStorageItems from activeNetworkStorage.ts, which counts that write.
export async function runSettingsStorageTransactionWith<Write extends LocalStorageItems, Result>(write: (items: Write) => Promise<unknown>, plan: () => Promise<StorageTransactionPlan<Result, Write>>) {
	return await settingsStorageLock.execute(async () => {
		const { writes, result } = await plan()
		const [firstWrite, ...laterWrites] = writes
		if (firstWrite !== undefined) await write(laterWrites.reduce<Write>((items, laterWrite) => ({ ...items, ...laterWrite }), firstWrite))
		return result
	})
}

// A settings storage transaction whose writes leave the active network alone.
export const runSettingsStorageTransaction = async <Result>(plan: () => Promise<StorageTransactionPlan<Result, StorageWrite>>) => await runSettingsStorageTransactionWith(browserStorageLocalSet, plan)

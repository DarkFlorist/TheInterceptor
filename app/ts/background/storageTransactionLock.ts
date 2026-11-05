import { Semaphore } from '../utils/semaphore.js'

const storageTransactionSemaphore = new Semaphore(1)

// One lock for the read-modify-write updaters of the address book, including its legacy key, signing preferences and website access, because the settings import writes those domains in its single transaction and must not interleave with them. Keys the import only overwrites have no read-modify-write updater, and other read-modify-write settings such as the make-me-rich settings stay outside the import and keep their own semaphores. One lock leaves no lock order to get wrong, and queueing these updaters behind each other is deliberate because a critical section is only a storage read, a synchronous update and a storage write. It is not reentrant, so a critical section must never call another of these updaters or wait on slow work such as RPC requests or popups.
export const withStorageTransactionLock = async (readModifyWrite: () => Promise<void>) => await storageTransactionSemaphore.execute(readModifyWrite)

import { Semaphore } from '../utils/semaphore.js'

const storageTransactionSemaphore = new Semaphore(1)

// One lock for the read-modify-write updaters of the address book, signing preferences and website access and for the settings import, which writes all of them in one transaction, so there is no lock order to get wrong. Queueing these unrelated updaters behind each other is deliberate, because a critical section is only a storage read, a synchronous update and a storage write. The lock is not reentrant, so a critical section must never call another of these updaters or wait on slow work such as RPC requests or popups.
export const withStorageTransactionLock = async (readModifyWrite: () => Promise<void>) => await storageTransactionSemaphore.execute(readModifyWrite)

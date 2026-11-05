import { Semaphore } from '../utils/semaphore.js'

const storageTransactionSemaphore = new Semaphore(1)

// One lock for exactly the keys the settings import writes in its single transaction: the address book, signing preferences and website access. That is what decides whether an updater uses it, so other read-modify-write settings such as the make-me-rich settings keep their own semaphores. One lock leaves no lock order to get wrong, and queueing these updaters behind each other is deliberate because a critical section is only a storage read, a synchronous update and a storage write. It is not reentrant, so a critical section must never call another of these updaters or wait on slow work such as RPC requests or popups.
export const withStorageTransactionLock = async (readModifyWrite: () => Promise<void>) => await storageTransactionSemaphore.execute(readModifyWrite)

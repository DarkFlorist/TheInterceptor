import { Semaphore } from '../utils/semaphore.js'

const settingsStorageSemaphore = new Semaphore(1)

// One lock for the address book, signing preference and website access updaters and for the settings import that writes all of them at once, so there is no lock order to get wrong. It is not reentrant: a critical section is a storage read, a synchronous update and a storage write, and must never call another of these updaters or wait on slow work such as RPC requests or popups.
export const withSettingsStorageLock = async (readModifyWrite: () => Promise<void>) => await settingsStorageSemaphore.execute(readModifyWrite)

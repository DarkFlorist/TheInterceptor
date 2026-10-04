import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet } from '../utils/storageUtils.js'
import type { SigningWalletBindings, SigningWalletBinding } from '../types/signingWallet.js'

const signingWalletSemaphore = new Semaphore(1)
/** Cross-repository operations acquire address-book ownership first, then binding ownership. */
export const withSigningWalletStore = <T>(operation: () => Promise<T>) => signingWalletSemaphore.execute(operation)

// Bindings are public identity only. A missing or corrupt binding never grants website access or establishes signing authority.
export async function readSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await browserStorageLocalGet('signingWalletBindings')).signingWalletBindings ?? []
}

/** Routing reads persisted public bindings without taking the address-book mutation lock; approval revalidates eligibility. */
export async function getStoredSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await readSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}


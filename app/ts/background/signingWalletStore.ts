import { browserStorageLocalGet } from '../utils/storageUtils.js'
import type { SigningWalletBindings, SigningWalletBinding } from '../types/signingWallet.js'
import type { StorageWrite } from './settingsStorageTransaction.js'

// Bindings change only together with the address book that decides their eligibility, so signingAddressBookCoordinator composes this write into a settings storage transaction.
export const signingWalletBindingsStorageWrite = (signingWalletBindings: SigningWalletBindings): StorageWrite => ({ signingWalletBindings })

// Bindings are public identity only. A missing or corrupt binding never grants website access or establishes signing authority.
export async function readSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await browserStorageLocalGet('signingWalletBindings')).signingWalletBindings ?? []
}

/** Routing reads persisted public bindings without taking the address-book mutation lock; approval revalidates eligibility. */
export async function getStoredSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await readSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

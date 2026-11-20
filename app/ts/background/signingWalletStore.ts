import { browserStorageLocalGet } from '../utils/storageUtils.js'
import type { SigningWalletBindings, SigningWalletBinding } from '../types/signingWallet.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'
import { getUserAddressBookEntries } from './addressBookStore.js'
import { reconcileSigningWalletBindings } from '../utils/signingWalletEligibility.js'

// Bindings change only together with the address book that decides their eligibility, so signingAddressBookCoordinator composes this write into a settings storage transaction.
export const signingWalletBindingsStorageWrite = (signingWalletBindings: SigningWalletBindings): StorageWrite => ({ signingWalletBindings })
export const isSigningWalletBindingsStorageWrite = (write: StorageWrite) => 'signingWalletBindings' in write

// Bindings are public identity only. A missing or corrupt binding never grants website access or establishes signing authority.
export async function readSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await browserStorageLocalGet('signingWalletBindings')).signingWalletBindings ?? []
}

/** Routing reads persisted public bindings without taking the address-book mutation lock; approval revalidates eligibility. */
export async function getStoredSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await readSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

// Reads only: binding writes go through signingAddressBookCoordinator. Read with the address book in one settings storage transaction, so the bindings returned are the ones eligible in that snapshot.
export async function getAddressBookAndSigningWalletBindings() {
	return await runSettingsStorageTransaction(async () => {
		const [entries, bindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		return { writes: [], result: { addressBookEntries: entries, signingWalletBindings: reconcileSigningWalletBindings(entries, bindings) } }
	})
}

export async function getSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await getAddressBookAndSigningWalletBindings()).signingWalletBindings
}

export async function getSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await getSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

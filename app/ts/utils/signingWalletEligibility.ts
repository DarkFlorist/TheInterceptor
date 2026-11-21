import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { SigningWalletBindings } from '../types/signingWallet.js'

// A binding is global to an ordinary address, retained while any chain-scoped entry remains. A Safe entry in any scope excludes the address from ordinary-account signing.
export function getOrdinarySigningAddresses(entries: AddressBookEntries) {
	const ordinaryAddresses = new Set(entries.filter((entry) => entry.type !== 'safe').map((entry) => entry.address))
	const safeAddresses = new Set(entries.filter((entry) => entry.type === 'safe').map((entry) => entry.address))
	return new Set([...ordinaryAddresses].filter((address) => !safeAddresses.has(address)))
}

export function reconcileSigningWalletBindings(entries: AddressBookEntries, bindings: SigningWalletBindings) {
	const eligibleAddresses = getOrdinarySigningAddresses(entries)
	return bindings.filter((binding) => eligibleAddresses.has(binding.wallet.address))
}

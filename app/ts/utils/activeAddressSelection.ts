import { doAddressBookChainIdsMatch, type AddressBookEntries, type AddressBookEntry } from '../types/addressBookTypes.js'
import type { TabState } from '../types/user-interface-types.js'

export type ActiveAddressSelection =
	| { readonly type: 'signer', readonly address: bigint | undefined }
	| { readonly type: 'addressBookEntry', readonly entry: AddressBookEntry }

export function getWalletSelectedAccount(tabState: Pick<TabState, 'activeSigningAddress' | 'signerAccounts'> | undefined) {
	return tabState?.activeSigningAddress ?? tabState?.signerAccounts[0]
}

export function includePersistedAddressBookEntry(activeAddresses: AddressBookEntries, persistedEntry: AddressBookEntry | undefined): AddressBookEntries {
	if (persistedEntry === undefined) return activeAddresses
	return [
		...activeAddresses.filter((entry) => entry.address !== persistedEntry.address || !doAddressBookChainIdsMatch(entry.chainId, persistedEntry.chainId)),
		persistedEntry,
	]
}

export function getSelectableActiveAddresses(activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]) {
	if (simulationMode) return activeAddresses.filter((entry) => entry.type !== 'safe' || entry.chainId === activeChainId)

	const selectedSignerAddress = signerAccounts[0]
	if (selectedSignerAddress === undefined) return []
	return activeAddresses.filter((entry) =>
		entry.type === 'safe'
		&& entry.chainId === activeChainId
		&& entry.safeSignerAddresses?.includes(selectedSignerAddress) === true
	)
}

export function isActiveAddressSelectionAllowed(address: bigint | 'signer', activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]) {
	return getActiveAddressSelection(address, activeAddresses, simulationMode, activeChainId, signerAccounts) !== undefined
}

export function getActiveAddressSelection(address: bigint | 'signer', activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]): ActiveAddressSelection | undefined {
	const selectedSignerAddress = signerAccounts[0]
	if ((address === 'signer' && selectedSignerAddress !== undefined) || (!simulationMode && address === selectedSignerAddress)) {
		return { type: 'signer', address: selectedSignerAddress }
	}
	const entry = getSelectableActiveAddresses(activeAddresses, simulationMode, activeChainId, signerAccounts).find((candidate) => candidate.address === address)
	return entry === undefined ? undefined : { type: 'addressBookEntry', entry }
}

export function assertActiveAddressSelectionAllowed(address: bigint | 'signer', activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]): ActiveAddressSelection {
	const selection = getActiveAddressSelection(address, activeAddresses, simulationMode, activeChainId, signerAccounts)
	if (selection !== undefined) return selection
	if (address !== 'signer') {
		const safeEntries = activeAddresses.filter((entry) => entry.type === 'safe' && entry.address === address)
		if (safeEntries.length > 0 && !safeEntries.some((entry) => entry.chainId === activeChainId)) {
			throw new Error('The selected Gnosis Safe is configured for another chain.')
		}
	}
	throw new Error(simulationMode
		? 'The selected address is not available for simulation.'
		: 'The selected address is not available for the current signing wallet.')
}

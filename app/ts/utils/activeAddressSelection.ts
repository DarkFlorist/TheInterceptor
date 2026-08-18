import { doAddressBookChainIdsMatch, type AddressBookEntries, type AddressBookEntry } from '../types/addressBookTypes.js'
import type { TabState } from '../types/user-interface-types.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from './addressBook.js'

export type ActiveAddressSelection =
	| { readonly type: 'signer', readonly address: bigint | undefined }
	| { readonly type: 'addressBookEntry', readonly entry: AddressBookEntry }

export type OptimisticActiveAddressSelection =
	| { readonly mode: 'simulation', readonly activeSimulationAddress: bigint | undefined, readonly useSignersAddressAsActiveAddress: boolean }
	| { readonly mode: 'signing', readonly displayedSigningAddress: bigint | undefined }

export type ModeActiveAddressResolution = {
	readonly activeAddress: bigint | undefined
	readonly activeAddressBookEntry: AddressBookEntry | undefined
	readonly safeSigningMode: boolean
}

export type SigningAddressSelection =
	| { readonly type: 'walletAccount', readonly address: bigint }
	| { readonly type: 'safe', readonly address: bigint }

export function findActiveAddressBookEntryForChain(
	activeAddresses: AddressBookEntries,
	address: bigint,
	activeChainId: bigint | undefined,
	selectionType: 'any' | 'walletAccount',
) {
	const activeChainAddresses = activeChainId === undefined ? activeAddresses : getAddressBookEntriesForChainIdMorePreciseFirst(activeAddresses, activeChainId)
	return activeChainAddresses.find((entry) => entry.address === address && (selectionType === 'any' || entry.type !== 'safe'))
}

/**
 * Resolves the effective address for the selected mode. An unavailable Safe
 * falls back to `walletSelectedAddress`; a wallet account remains the active
 * signing address directly.
 */
export function resolveActiveAddressForMode(
	activeAddresses: AddressBookEntries,
	simulationMode: boolean,
	activeSimulationAddress: bigint | undefined,
	selectedSigningAddress: SigningAddressSelection | undefined,
	activeChainId: bigint | undefined,
	signerAccounts: readonly bigint[],
	walletSelectedAddress: bigint | undefined,
): ModeActiveAddressResolution {
	const configuredAddress = simulationMode ? activeSimulationAddress : selectedSigningAddress?.address
	if (!simulationMode) {
		if (configuredAddress === undefined || selectedSigningAddress === undefined) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
		if (selectedSigningAddress.type === 'walletAccount') {
			const activeAddressBookEntry = findActiveAddressBookEntryForChain(activeAddresses, configuredAddress, activeChainId, 'walletAccount')
			return { activeAddress: configuredAddress, activeAddressBookEntry, safeSigningMode: false }
		}
		const activeSigningSafe = resolveSigningSafe(configuredAddress, activeChainId, signerAccounts, activeAddresses)
		if (activeSigningSafe !== undefined) return { activeAddress: configuredAddress, activeAddressBookEntry: activeSigningSafe, safeSigningMode: true }
		const activeAddress = walletSelectedAddress
		if (activeAddress === undefined) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
		const activeAddressBookEntry = findActiveAddressBookEntryForChain(activeAddresses, activeAddress, activeChainId, 'walletAccount')
		return { activeAddress, activeAddressBookEntry, safeSigningMode: false }
	}
	if (configuredAddress === undefined) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
	const activeAddressBookEntry = findActiveAddressBookEntryForChain(activeAddresses, configuredAddress, activeChainId, 'any')
	const isSafeOnAnotherChain = simulationMode && activeAddressBookEntry === undefined
		&& activeAddresses.some((entry) => entry.type === 'safe' && entry.address === configuredAddress)
	if (isSafeOnAnotherChain) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
	return {
		activeAddress: configuredAddress,
		activeAddressBookEntry,
		safeSigningMode: false,
	}
}

export function getDisplayedSigningAddressSelection(displayedSigningAddress: bigint | undefined, activeSigningSafeAddress: bigint | undefined): SigningAddressSelection | undefined {
	if (displayedSigningAddress === undefined) return undefined
	return displayedSigningAddress === activeSigningSafeAddress
		? { type: 'safe', address: displayedSigningAddress }
		: { type: 'walletAccount', address: displayedSigningAddress }
}

export function resolveSigningSafe(configuredSafeAddress: bigint | undefined, activeChainId: bigint | undefined, signerAccounts: readonly bigint[], activeAddresses: AddressBookEntries) {
	if (configuredSafeAddress === undefined || activeChainId === undefined) return undefined
	return getSelectableActiveAddresses(activeAddresses, false, activeChainId, signerAccounts)
		.find((entry) => entry.address === configuredSafeAddress)
}

export function getOptimisticActiveAddressSelection(address: bigint | 'signer', simulationMode: boolean, signerAccounts: readonly bigint[]): OptimisticActiveAddressSelection {
	const resolvedAddress = address === 'signer' ? signerAccounts[0] : address
	return simulationMode
		? { mode: 'simulation', activeSimulationAddress: resolvedAddress, useSignersAddressAsActiveAddress: address === 'signer' }
		: { mode: 'signing', displayedSigningAddress: resolvedAddress }
}

export function getWalletSelectedAccount(tabState: Pick<TabState, 'activeSigningAddress' | 'signerAccounts'> | undefined) {
	return tabState?.activeSigningAddress ?? tabState?.signerAccounts[0]
}

export function isSignerConnectedForMode(simulationMode: boolean, activeSimulationAddress: bigint | undefined, tabState: Pick<TabState, 'signerAccounts'> | undefined) {
	const signerAddress = tabState?.signerAccounts[0]
	return simulationMode
		? activeSimulationAddress !== undefined && signerAddress === activeSimulationAddress
		: signerAddress !== undefined
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
	if (address === 'signer' && selectedSignerAddress !== undefined) {
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

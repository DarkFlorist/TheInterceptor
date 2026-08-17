import { doAddressBookChainIdsMatch, type AddressBookEntries, type AddressBookEntry } from '../types/addressBookTypes.js'
import type { TabState } from '../types/user-interface-types.js'

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

export function resolveActiveAddressForMode(
	activeAddresses: AddressBookEntries,
	simulationMode: boolean,
	activeSimulationAddress: bigint | undefined,
	displayedSigningAddress: bigint | undefined,
	activeChainId: bigint | undefined,
): ModeActiveAddressResolution {
	const configuredAddress = simulationMode ? activeSimulationAddress : displayedSigningAddress
	if (configuredAddress === undefined) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
	const currentChainSafe = activeAddresses.find((entry) =>
		entry.type === 'safe' && entry.address === configuredAddress && entry.chainId === activeChainId
	)
	const activeAddressBookEntry = !simulationMode && currentChainSafe !== undefined
		? currentChainSafe
		: activeAddresses.find((entry) =>
			entry.address === configuredAddress && (entry.type !== 'safe' || entry.chainId === activeChainId)
		)
	const isSafeOnAnotherChain = (simulationMode ? activeAddressBookEntry === undefined : currentChainSafe === undefined)
		&& activeAddresses.some((entry) => entry.type === 'safe' && entry.address === configuredAddress)
	if (isSafeOnAnotherChain) return { activeAddress: undefined, activeAddressBookEntry: undefined, safeSigningMode: false }
	const activeSigningSafe = !simulationMode && activeAddressBookEntry?.type === 'safe' ? activeAddressBookEntry : undefined
	return {
		activeAddress: configuredAddress,
		activeAddressBookEntry,
		safeSigningMode: activeSigningSafe !== undefined,
	}
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

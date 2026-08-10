import type { AddressBookEntries } from '../types/addressBookTypes.js'

export function getSelectableActiveAddresses(activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]) {
	if (simulationMode) return activeAddresses.filter((entry) => entry.type !== 'safe' || entry.chainId === activeChainId)

	const selectedSignerAddress = signerAccounts[0]
	return activeAddresses.filter((entry) =>
		entry.type === 'safe'
		&& entry.chainId === activeChainId
		&& (selectedSignerAddress === undefined || entry.safeSignerAddresses?.includes(selectedSignerAddress) === true)
	)
}

export function isActiveAddressSelectionAllowed(address: bigint | 'signer', activeAddresses: AddressBookEntries, simulationMode: boolean, activeChainId: bigint | undefined, signerAccounts: readonly bigint[]) {
	if (address === 'signer') return true
	return getSelectableActiveAddresses(activeAddresses, simulationMode, activeChainId, signerAccounts).some((entry) => entry.address === address)
}

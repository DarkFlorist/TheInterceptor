import type { AddressBookEntries, AddressBookEntry, ChainIdWithUniversal } from '../types/addressBookTypes.js'

export function getAddressBookEntriesForChainIdMorePreciseFirst(addressBookEntries: AddressBookEntries, chainId: ChainIdWithUniversal) {
	const entries = addressBookEntries.filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
	return entries.sort((x, y) => {
		if (x.entrySource === 'OnChain' && y.entrySource !== 'OnChain') return 1
		if (x.entrySource !== 'OnChain' && y.entrySource === 'OnChain') return -1
		if (typeof x.chainId === 'bigint' && typeof y.chainId !== 'bigint') return -1
		if (typeof x.chainId !== 'bigint' && typeof y.chainId === 'bigint') return 1
		return 0
	})
}

// How much is known about an address, from the source of its address book entry.
export type AddressTrust = 'addressBook' | 'known' | 'selfReported' | 'unknown'

export function getAddressTrust(addressBookEntry: AddressBookEntry): AddressTrust {
	switch (addressBookEntry.entrySource) {
		case 'User': return 'addressBook'
		case 'DarkFloristMetadata':
		case 'Interceptor': return 'known'
		case 'OnChain': return 'selfReported'
		case 'FilledIn': return 'unknown'
	}
}

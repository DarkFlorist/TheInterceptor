import type { AddressBookEntries, ChainIdWithUniversal } from '../types/addressBookTypes.js'

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

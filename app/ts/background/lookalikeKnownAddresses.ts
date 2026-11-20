import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { indexKnownAddresses, indexRecognizedAddressBookEntries, type KnownAddressIndex } from '../utils/lookalikeAddresses.js'
import { type BundledMetadata, listBundledMetadataForChain } from './bundledMetadata.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

let bundledMetadataIndex: { readonly bundledMetadata: readonly BundledMetadata[], readonly index: KnownAddressIndex } | undefined

// The bundled metadata is static and has about ten thousand entries, so its index is built once and reused while listBundledMetadataForChain returns the same list; a chain without bundled metadata gets no index.
const getBundledMetadataIndexes = (chainId: bigint): readonly KnownAddressIndex[] => {
	const bundledMetadata = listBundledMetadataForChain(chainId)
	if (bundledMetadata.length === 0) return []
	if (bundledMetadataIndex?.bundledMetadata !== bundledMetadata) bundledMetadataIndex = { bundledMetadata, index: indexKnownAddresses(bundledMetadata.map(({ address, definition }) => ({ name: definition.name, address }))) }
	return [bundledMetadataIndex.index]
}

// User vetted address book entries come first so a warning names the user's own entry when it also resembles a bundled one; listBundledMetadataForChain decides on which chains bundled metadata applies, as it does for identifyAddress.
export const getKnownAddressIndexes = (addressBookEntriesForChain: AddressBookEntries, chainId: bigint): readonly KnownAddressIndex[] => [
	indexRecognizedAddressBookEntries(addressBookEntriesForChain),
	...getBundledMetadataIndexes(chainId),
]

// Lookalike detection compares a destination with every vetted entry of the chain instead of resolving one address, so it reads the whole per-chain address book through the accessor identifyAddress searches.
export const loadKnownAddressIndexesForChain = async (chainId: bigint) => getKnownAddressIndexes(await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId), chainId)

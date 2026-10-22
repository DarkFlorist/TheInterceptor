import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { indexKnownAddresses, indexRecognizedAddressBookEntries, type KnownAddressIndex } from '../utils/lookalikeAddresses.js'
import { listBundledMetadata } from './bundledMetadata.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

let bundledMetadataIndex: KnownAddressIndex | undefined

// The bundled metadata is static and has about ten thousand entries, so its index is built once on first use.
const getBundledMetadataIndex = () => {
	if (bundledMetadataIndex !== undefined) return bundledMetadataIndex
	bundledMetadataIndex = indexKnownAddresses(listBundledMetadata().map(({ address, definition }) => ({ name: definition.name, address })))
	return bundledMetadataIndex
}

// User vetted address book entries come first so a warning names the user's own entry when it also resembles a bundled one; bundled metadata describes Ethereum mainnet, where the address book also lists it.
export const getKnownAddressIndexes = (addressBookEntriesForChain: AddressBookEntries, chainId: bigint): readonly KnownAddressIndex[] => [
	indexRecognizedAddressBookEntries(addressBookEntriesForChain),
	...(chainId === 1n ? [getBundledMetadataIndex()] : []),
]

// Lookalike detection compares a destination with every vetted entry of the chain instead of resolving one address, so it reads the whole per-chain address book through the accessor identifyAddress searches.
export const loadKnownAddressIndexesForChain = async (chainId: bigint) => getKnownAddressIndexes(await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId), chainId)

import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressString } from '../utils/bigint.js'

// Re-keys the entries stored under a key that is not lower case by their lower case address. If a map stores one address under several such keys, the first key in map order wins.
const indexEntriesWithoutLowerCaseKey = <Definition>(metadata: ReadonlyMap<string, Definition>): ReadonlyMap<string, Definition> => {
	const index = new Map<string, Definition>()
	for (const [key, definition] of metadata) {
		const lowerCaseKey = key.toLowerCase()
		if (key !== lowerCaseKey && !index.has(lowerCaseKey)) index.set(lowerCaseKey, definition)
	}
	return index
}

// The bundled maps key almost every address by its lower case string, but some tokens only by their checksummed string, which a lower case lookup never matches. The lower case key is read first, so an address stored under both casings keeps the entry it has always resolved to, and the other casings are consulted only on a miss. That index is built once, on the first miss, and holds only the few entries whose key is not lower case.
const createBundledMetadataLookup = <Definition>(metadata: ReadonlyMap<string, Definition>) => {
	let entriesWithoutLowerCaseKey: ReadonlyMap<string, Definition> | undefined
	return (address: EthereumAddress): Definition | undefined => {
		const lowerCaseKey = addressString(address)
		const definition = metadata.get(lowerCaseKey)
		if (definition !== undefined) return definition
		if (entriesWithoutLowerCaseKey === undefined) entriesWithoutLowerCaseKey = indexEntriesWithoutLowerCaseKey(metadata)
		return entriesWithoutLowerCaseKey.get(lowerCaseKey)
	}
}

export const getBundledContractMetadata = createBundledMetadataLookup(contractMetadata)
export const getBundledTokenMetadata = createBundledMetadataLookup(tokenMetadata)
export const getBundledErc721Metadata = createBundledMetadataLookup(erc721Metadata)
export const getBundledErc1155Metadata = createBundledMetadataLookup(erc1155Metadata)

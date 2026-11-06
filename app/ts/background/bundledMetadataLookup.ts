import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressString } from '../utils/bigint.js'

// The bundled maps key almost every address by its lower case string, but some tokens only by their checksummed string, and some under both casings with different data. This module is the only reader of those raw maps and re-keys each by lower case address. The lower case key's entry wins, so an address stored under both casings keeps the entry it has always resolved to, and among several other casings the first key in map order wins. Each address stays at the position of its first key in map order, so a listing only loses the shadowed duplicates.
const keyByLowerCaseAddress = <Definition>(metadata: ReadonlyMap<string, Definition>): ReadonlyMap<string, Definition> => {
	const canonical = new Map<string, Definition>()
	for (const [key, definition] of metadata) {
		const lowerCaseKey = key.toLowerCase()
		// A later lower case key overwrites an earlier casing's entry, and Map.set keeps the address at the earlier key's position.
		const isShadowed = key !== lowerCaseKey && canonical.has(lowerCaseKey)
		if (!isShadowed) canonical.set(lowerCaseKey, definition)
	}
	return canonical
}

// Re-keys every entry by lower case address in map order, including the ones the canonical map shadows.
function* keyEveryEntryByLowerCaseAddress<Definition>(metadata: ReadonlyMap<string, Definition>): Generator<[string, Definition]> {
	for (const [key, definition] of metadata) yield [key.toLowerCase(), definition]
}

// Each canonical map is built once, on first use, and holds the bundled definition objects themselves rather than copies.
const createBundledMetadataCategory = <Definition>(metadata: ReadonlyMap<string, Definition>) => {
	let canonical: ReadonlyMap<string, Definition> | undefined
	const getCanonical = () => {
		if (canonical === undefined) canonical = keyByLowerCaseAddress(metadata)
		return canonical
	}
	return {
		lookup: (address: EthereumAddress): Definition | undefined => getCanonical().get(addressString(address)),
		list: () => getCanonical().entries(),
		listEvery: () => keyEveryEntryByLowerCaseAddress(metadata),
	}
}

// A checksummed key is an ordinary entry of the same curated @darkflorist/address-metadata map, so an entry re-keyed from either casing is trusted like a lower case one: callers mark its lookups and listings 'DarkFloristMetadata', not 'OnChain', which deliberately changes every 'OnChain'-gated behaviour, such as the non-contact warning and the untrusted address badge. The package version is pinned exactly, and test/tests/bundledMetadataLookup.test.ts lists every checksummed-only key it trusts this way, so a dependency bump that changes that set fails until the list is reviewed.
const bundledContracts = createBundledMetadataCategory(contractMetadata)
const bundledTokens = createBundledMetadataCategory(tokenMetadata)
const bundledErc721s = createBundledMetadataCategory(erc721Metadata)
const bundledErc1155s = createBundledMetadataCategory(erc1155Metadata)

export const getBundledContractMetadata = bundledContracts.lookup
export const getBundledTokenMetadata = bundledTokens.lookup
export const getBundledErc721Metadata = bundledErc721s.lookup
export const getBundledErc1155Metadata = bundledErc1155s.lookup

// Each lists its category once per address, keyed by lower case address string, in bundled map order.
export const listBundledContractMetadata = bundledContracts.list
export const listBundledTokenMetadata = bundledTokens.list
export const listBundledErc721Metadata = bundledErc721s.list
export const listBundledErc1155Metadata = bundledErc1155s.list

// Each yields every bundled entry of its category, including the ones the lookup shadows, keyed by lower case address string, in bundled map order. Name and symbol matching reads these because a shadowed entry's name is still a bundled name of its address, and a match then shows the lookup's entry for that address.
export const listEveryBundledContractMetadata = bundledContracts.listEvery
export const listEveryBundledTokenMetadata = bundledTokens.listEvery
export const listEveryBundledErc721Metadata = bundledErc721s.listEvery
export const listEveryBundledErc1155Metadata = bundledErc1155s.listEvery

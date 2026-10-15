import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'

// The bundled maps mix lowercase and EIP-55 checksummed keys; when both forms exist for one address the lowercase entry wins so already recognized tokens keep their current name, symbol and logo.
function indexByLowercaseAddress<Definition>(metadata: ReadonlyMap<string, Definition>): ReadonlyMap<string, Definition> {
	const indexed = new Map<string, Definition>()
	for (const [address, definition] of metadata) {
		const lowercaseAddress = address.toLowerCase()
		if (address === lowercaseAddress || !indexed.has(lowercaseAddress)) indexed.set(lowercaseAddress, definition)
	}
	return indexed
}

// Read bundled metadata only through these maps, keyed by lowercase `0x` address strings as produced by `addressString`.
export const bundledTokenMetadata = indexByLowercaseAddress(tokenMetadata)
export const bundledContractMetadata = indexByLowercaseAddress(contractMetadata)
export const bundledErc721Metadata = indexByLowercaseAddress(erc721Metadata)
export const bundledErc1155Metadata = indexByLowercaseAddress(erc1155Metadata)

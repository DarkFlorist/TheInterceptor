import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata, type ContractDefinition, type Erc1155Definition, type Erc721Definition, type TokenDefinition } from '@darkflorist/address-metadata'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressString } from '../utils/bigint.js'

export type BundledMetadata = { readonly address: EthereumAddress } & (
	| { readonly type: 'contract', readonly definition: ContractDefinition }
	| { readonly type: 'ERC20', readonly definition: TokenDefinition }
	| { readonly type: 'ERC721', readonly definition: Erc721Definition }
	| { readonly type: 'ERC1155', readonly definition: Erc1155Definition }
)

// The bundled @darkflorist/address-metadata entries describe Ethereum mainnet contracts only; only the chain aware accessors below expose them, so address identification and lookalike detection apply them on the same chains.
const BUNDLED_METADATA_CHAIN_ID = 1n

// Looks the address up by its lower case string, so the few tokens the package stores only under checksummed keys are not found. An address in several maps is described by the first of contracts, tokens, ERC721 and ERC1155.
const findBundledMetadata = (address: EthereumAddress): BundledMetadata | undefined => {
	const key = addressString(address)
	const contract = contractMetadata.get(key)
	if (contract !== undefined) return { address, type: 'contract', definition: contract }
	const token = tokenMetadata.get(key)
	if (token !== undefined) return { address, type: 'ERC20', definition: token }
	const erc721 = erc721Metadata.get(key)
	if (erc721 !== undefined) return { address, type: 'ERC721', definition: erc721 }
	const erc1155 = erc1155Metadata.get(key)
	if (erc1155 !== undefined) return { address, type: 'ERC1155', definition: erc1155 }
	return undefined
}

let bundledMetadataList: readonly BundledMetadata[] | undefined

// Lists exactly what findBundledMetadata finds, once per address, so code that enumerates the bundled metadata knows the same addresses and names as address lookups. The data is static, so the list is built once on first use.
const listBundledMetadata = (): readonly BundledMetadata[] => {
	if (bundledMetadataList !== undefined) return bundledMetadataList
	const addresses = new Set([contractMetadata, tokenMetadata, erc721Metadata, erc1155Metadata].flatMap((metadata) => Array.from(metadata.keys(), (key) => BigInt(key))))
	bundledMetadataList = Array.from(addresses).flatMap((address) => findBundledMetadata(address) ?? [])
	return bundledMetadataList
}

const appliesToChain = (chainId: bigint) => chainId === BUNDLED_METADATA_CHAIN_ID

export const findBundledMetadataForChain = (address: EthereumAddress, chainId: bigint): BundledMetadata | undefined => appliesToChain(chainId) ? findBundledMetadata(address) : undefined

// Returns the same cached list for every chain the metadata applies to, so callers can cache work derived from it by list identity.
export const listBundledMetadataForChain = (chainId: bigint): readonly BundledMetadata[] => appliesToChain(chainId) ? listBundledMetadata() : []

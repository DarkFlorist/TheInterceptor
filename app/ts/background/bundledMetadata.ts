import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata, type ContractDefinition, type Erc1155Definition, type Erc721Definition, type TokenDefinition } from '@darkflorist/address-metadata'
import type { AddressBookEntry, ChainIdWithUniversal, ContractEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { assertNever } from '../utils/typescript.js'
import { addressString } from '../utils/bigint.js'

export type BundledMetadata = { readonly address: EthereumAddress } & (
	| { readonly type: 'contract', readonly definition: ContractDefinition }
	| { readonly type: 'ERC20', readonly definition: TokenDefinition }
	| { readonly type: 'ERC721', readonly definition: Erc721Definition }
	| { readonly type: 'ERC1155', readonly definition: Erc1155Definition }
)

// The bundled @darkflorist/address-metadata entries describe Ethereum mainnet contracts only; this module alone reads the package and decides on which chains it applies, so address identification, address book search and lookalike detection apply it on the same chains.
const BUNDLED_METADATA_CHAIN_ID = 1n

const LOGO_URI_PREFIX = '../vendor/@darkflorist/address-metadata'

const pathJoin = (parts: string[], sep = '/') => parts.join(sep).replace(new RegExp(sep + '{1,}', 'g'), sep)

const getLogoUri = (logoUri: string | undefined) => logoUri !== undefined ? { logoUri: `${ pathJoin([LOGO_URI_PREFIX, logoUri]) }` } : {}

const toContractEntry = (address: EthereumAddress, { logoUri, ...rest }: ContractDefinition): ContractEntry => ({ ...rest, ...getLogoUri(logoUri), address, type: 'contract', entrySource: 'DarkFloristMetadata' })
const toErc20TokenEntry = (address: EthereumAddress, { logoUri, ...rest }: TokenDefinition): Erc20TokenEntry => ({ ...rest, ...getLogoUri(logoUri), address, type: 'ERC20', entrySource: 'DarkFloristMetadata' })
const toErc721Entry = (address: EthereumAddress, { logoUri, ...rest }: Erc721Definition): Erc721Entry => ({ ...rest, ...getLogoUri(logoUri), address, type: 'ERC721', entrySource: 'DarkFloristMetadata' })
const toErc1155Entry = (address: EthereumAddress, { logoUri, ...rest }: Erc1155Definition): Erc1155Entry => ({ ...rest, ...getLogoUri(logoUri), address, type: 'ERC1155', entrySource: 'DarkFloristMetadata', decimals: undefined })

// The one conversion from a bundled definition to an address book entry, shared by address identification and address book search.
export const bundledMetadataToAddressBookEntry = (bundledMetadata: BundledMetadata): AddressBookEntry => {
	switch (bundledMetadata.type) {
		case 'contract': return toContractEntry(bundledMetadata.address, bundledMetadata.definition)
		case 'ERC20': return toErc20TokenEntry(bundledMetadata.address, bundledMetadata.definition)
		case 'ERC721': return toErc721Entry(bundledMetadata.address, bundledMetadata.definition)
		case 'ERC1155': return toErc1155Entry(bundledMetadata.address, bundledMetadata.definition)
		default: return assertNever(bundledMetadata)
	}
}

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

type BundledAddressBookEntries = {
	readonly contracts: readonly ContractEntry[],
	readonly erc20Tokens: readonly Erc20TokenEntry[],
	readonly erc721Tokens: readonly Erc721Entry[],
	readonly erc1155Tokens: readonly Erc1155Entry[],
}

const NO_BUNDLED_ADDRESS_BOOK_ENTRIES: BundledAddressBookEntries = { contracts: [], erc20Tokens: [], erc721Tokens: [], erc1155Tokens: [] }

let bundledAddressBookEntries: BundledAddressBookEntries | undefined

// Unlike listBundledMetadata, keeps every key of each package map in package order, so the address book also shows the tokens stored only under checksummed keys, a token stored under both key forms twice, and an address in several maps in each of its categories, as it always has.
const getBundledAddressBookEntries = (): BundledAddressBookEntries => {
	bundledAddressBookEntries ??= {
		contracts: Array.from(contractMetadata, ([key, definition]) => toContractEntry(BigInt(key), definition)),
		erc20Tokens: Array.from(tokenMetadata, ([key, definition]) => toErc20TokenEntry(BigInt(key), definition)),
		erc721Tokens: Array.from(erc721Metadata, ([key, definition]) => toErc721Entry(BigInt(key), definition)),
		erc1155Tokens: Array.from(erc1155Metadata, ([key, definition]) => toErc1155Entry(BigInt(key), definition)),
	}
	return bundledAddressBookEntries
}

const appliesToChain = (chainId: bigint) => chainId === BUNDLED_METADATA_CHAIN_ID

export const findBundledMetadataForChain = (address: EthereumAddress, chainId: bigint): BundledMetadata | undefined => appliesToChain(chainId) ? findBundledMetadata(address) : undefined

// Returns the same cached list for every chain the metadata applies to, so callers can cache work derived from it by list identity.
export const listBundledMetadataForChain = (chainId: bigint): readonly BundledMetadata[] => appliesToChain(chainId) ? listBundledMetadata() : []

// The bundled entries an address book view of the chain lists; an AllChains view lists only universal user entries, so it gets none.
export const listBundledAddressBookEntriesForChain = (chainId: ChainIdWithUniversal): BundledAddressBookEntries => chainId !== 'AllChains' && appliesToChain(chainId) ? getBundledAddressBookEntries() : NO_BUNDLED_ADDRESS_BOOK_ENTRIES

// The bundled entries whose name or symbol a new entry for the chain must not reuse; an AllChains entry is also used on the chains the bundled metadata applies to, so it is checked against them too.
export const listBundledAddressBookEntriesForNameCollisionCheck = (chainId: ChainIdWithUniversal): BundledAddressBookEntries => chainId === 'AllChains' || appliesToChain(chainId) ? getBundledAddressBookEntries() : NO_BUNDLED_ADDRESS_BOOK_ENTRIES

// Ignores the chain on purpose: the common token protector has always flagged a transfer of any bundled token address to a router, whichever chain it is on.
export const isBundledTokenAddressOnAnyChain = (address: EthereumAddress) => {
	const key = addressString(address)
	return tokenMetadata.has(key) || erc721Metadata.has(key) || erc1155Metadata.has(key)
}

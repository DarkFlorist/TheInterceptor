import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressStringWithout0x } from '../utils/bigint.js'

// Address poisoning addresses copy the leading and trailing hex characters that wallets and explorers display (usually 4-6 leading and 4 trailing), while two unrelated addresses share 4 + 4 characters with a probability of only 1 in 16^8 (about 1 in 4.3 billion).
const LOOKALIKE_PREFIX_HEX_LENGTH = 4
const LOOKALIKE_SUFFIX_HEX_LENGTH = 4

export type KnownAddress = { readonly name: string, readonly address: EthereumAddress }

// Known addresses grouped by their lookalike key, so each destination is compared with a single map lookup instead of a scan over the whole address book.
export type KnownAddressIndex = ReadonlyMap<string, readonly KnownAddress[]>

// Addresses are numbers, so the hex string is always lower case and the comparison ignores checksum casing.
const getLookalikeKey = (address: EthereumAddress) => {
	const hexWithout0x = addressStringWithout0x(address)
	return `${ hexWithout0x.slice(0, LOOKALIKE_PREFIX_HEX_LENGTH) }${ hexWithout0x.slice(-LOOKALIKE_SUFFIX_HEX_LENGTH) }`
}

const indexKnownAddresses = (knownAddresses: readonly KnownAddress[]): KnownAddressIndex => {
	const index = new Map<string, KnownAddress[]>()
	for (const knownAddress of knownAddresses) {
		const key = getLookalikeKey(knownAddress.address)
		const knownAddressesWithSameKey = index.get(key)
		if (knownAddressesWithSameKey === undefined) {
			index.set(key, [knownAddress])
			continue
		}
		knownAddressesWithSameKey.push(knownAddress)
	}
	return index
}

// OnChain entries are added automatically for every address the extension sees (including poisoning addresses) and FilledIn entries are placeholders, so neither tells that the user vetted the address.
const isRecognizedAddressBookEntry = (entry: AddressBookEntry) => entry.entrySource !== 'OnChain' && entry.entrySource !== 'FilledIn'

let bundledMetadataIndex: KnownAddressIndex | undefined

// The bundled metadata is static and has about ten thousand entries, so its index is built once on first use.
const getBundledMetadataIndex = () => {
	if (bundledMetadataIndex !== undefined) return bundledMetadataIndex
	const bundledMetadata = [...tokenMetadata, ...contractMetadata, ...erc721Metadata, ...erc1155Metadata]
	bundledMetadataIndex = indexKnownAddresses(bundledMetadata.map(([address, definition]) => ({ name: definition.name, address: BigInt(address) })))
	return bundledMetadataIndex
}

// User vetted address book entries come first so a warning names the user's own entry when it also resembles a bundled one; bundled metadata describes Ethereum mainnet, where the address book also lists it.
export const getKnownAddressIndexes = (addressBookEntriesForChain: AddressBookEntries, chainId: bigint): readonly KnownAddressIndex[] => [
	indexKnownAddresses(addressBookEntriesForChain.filter(isRecognizedAddressBookEntry)),
	...(chainId === 1n ? [getBundledMetadataIndex()] : []),
]

// Supplied by the caller (the background layer reads the stored address book), so this module stays free of storage access.
export type KnownAddressIndexesLoader = () => Promise<readonly KnownAddressIndex[]>

// Some bundled tokens exist only under checksummed keys that identifyAddress does not recognize, so an exact match with a known address must also rule out a lookalike.
const findLookalikeKnownAddress = (destination: AddressBookEntry, knownAddressIndexes: readonly KnownAddressIndex[]) => {
	const key = getLookalikeKey(destination.address)
	const knownAddressesWithSameKey = knownAddressIndexes.flatMap((index) => index.get(key) ?? [])
	if (knownAddressesWithSameKey.some((knownAddress) => knownAddress.address === destination.address)) return undefined
	return knownAddressesWithSameKey[0]
}

export type LookalikeDestination = { readonly destination: AddressBookEntry, readonly lookalikeOf: KnownAddress }

// Recognized destinations are never lookalikes, so the known addresses are loaded once, and only when some destination is unrecognized.
export async function findLookalikeDestinations(destinations: readonly AddressBookEntry[], loadKnownAddressIndexes: KnownAddressIndexesLoader): Promise<readonly LookalikeDestination[]> {
	const unrecognizedDestinations = destinations.filter((destination) => !isRecognizedAddressBookEntry(destination))
	if (unrecognizedDestinations.length === 0) return []
	const knownAddressIndexes = await loadKnownAddressIndexes()
	return unrecognizedDestinations.flatMap((destination) => {
		const lookalikeOf = findLookalikeKnownAddress(destination, knownAddressIndexes)
		return lookalikeOf === undefined ? [] : [{ destination, lookalikeOf }]
	})
}

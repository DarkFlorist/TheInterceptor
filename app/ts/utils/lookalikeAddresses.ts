import { isRecognizedEntrySource, type AddressBookEntries, type AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressStringWithout0x } from './bigint.js'

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

export const indexKnownAddresses = (knownAddresses: readonly KnownAddress[]): KnownAddressIndex => {
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

// Only recognized entries are imitation targets, because OnChain entries are recorded for every address the extension sees, including poisoning addresses.
export const indexRecognizedAddressBookEntries = (addressBookEntries: AddressBookEntries) => indexKnownAddresses(addressBookEntries.filter((entry) => isRecognizedEntrySource(entry.entrySource)))

// Supplied by the caller (the background layer reads the stored address book and the bundled metadata), so this module only matches addresses.
export type KnownAddressIndexesLoader = () => Promise<readonly KnownAddressIndex[]>

// identifyAddress returns a stored OnChain entry before bundled metadata, for example for an address auto-added before the bundled metadata listed it, so an exact match with a known address must also rule out a lookalike.
const findLookalikeKnownAddress = (destination: AddressBookEntry, knownAddressIndexes: readonly KnownAddressIndex[]) => {
	const key = getLookalikeKey(destination.address)
	const knownAddressesWithSameKey = knownAddressIndexes.flatMap((index) => index.get(key) ?? [])
	if (knownAddressesWithSameKey.some((knownAddress) => knownAddress.address === destination.address)) return undefined
	return knownAddressesWithSameKey[0]
}

export type LookalikeDestination = { readonly destination: AddressBookEntry, readonly lookalikeOf: KnownAddress }

// Recognized destinations are never lookalikes, so the known addresses are loaded once, and only when some destination is unrecognized.
export async function findLookalikeDestinations(destinations: readonly AddressBookEntry[], loadKnownAddressIndexes: KnownAddressIndexesLoader): Promise<readonly LookalikeDestination[]> {
	const unrecognizedDestinations = destinations.filter((destination) => !isRecognizedEntrySource(destination.entrySource))
	if (unrecognizedDestinations.length === 0) return []
	const knownAddressIndexes = await loadKnownAddressIndexes()
	return unrecognizedDestinations.flatMap((destination) => {
		const lookalikeOf = findLookalikeKnownAddress(destination, knownAddressIndexes)
		return lookalikeOf === undefined ? [] : [{ destination, lookalikeOf }]
	})
}

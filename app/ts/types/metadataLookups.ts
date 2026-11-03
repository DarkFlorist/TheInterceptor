import type { AddressBookEntry } from './addressBookTypes.js'
import type { EthereumAddress, EthereumBytes32 } from './wire-types.js'

// Resolves an address to the address-book entry a visualisation shows for it.
export type IdentifyAddress = (address: EthereumAddress) => Promise<AddressBookEntry>
// Resolves the ENS name of a name hash that the stored ENS names do not know, or undefined.
export type LookUpEnsName = (nameHash: EthereumBytes32) => Promise<string | undefined>

// How a visualisation looks up the metadata it does not take from the simulation.
export type MetadataLookups = {
	readonly identifyAddress: IdentifyAddress
	readonly lookUpEnsName: LookUpEnsName
}

import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'

export type EntrySource = funtypes.Static<typeof EntrySource>
export const EntrySource = funtypes.Union(
	funtypes.Literal('DarkFloristMetadata'),
	funtypes.Literal('User'),
	funtypes.Literal('Interceptor'),
	funtypes.Literal('OnChain'),
	funtypes.Literal('FilledIn'),
)

export type ActiveAddress = funtypes.Static<typeof ActiveAddress>
export const ActiveAddress = funtypes.ReadonlyObject({
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
}).asReadonly()

export type ActiveAddressArray = funtypes.Static<typeof ActiveAddressArray>
export const ActiveAddressArray = funtypes.ReadonlyArray(ActiveAddress)

export type ActiveAddressEntry = funtypes.Static<typeof ActiveAddressEntry>
export const ActiveAddressEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('activeAddress'),
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
	entrySource: EntrySource,
})

export type Erc20TokenEntry = funtypes.Static<typeof Erc20TokenEntry>
export const Erc20TokenEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC20'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type Erc721Entry = funtypes.Static<typeof Erc721Entry>
export const Erc721Entry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC721'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type Erc1155Entry = funtypes.Static<typeof Erc1155Entry>
export const Erc1155Entry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC1155'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: funtypes.Undefined,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type ContactEntry = funtypes.Static<typeof ContactEntry>
export const ContactEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('contact'),
	name: funtypes.String,
	address: EthereumAddress,
	entrySource: funtypes.Union(EntrySource, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'User' as const))),
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type ContactEntries = funtypes.Static<typeof ContactEntries>
export const ContactEntries = funtypes.ReadonlyArray(ContactEntry)

export type ContractEntry = funtypes.Static<typeof ContractEntry>
export const ContractEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('contract'),
	name: funtypes.String,
	address: EthereumAddress,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type AddressBookEntryCategory = 'contact' | 'activeAddress' | 'ERC20' | 'ERC721' | 'contract' | 'ERC1155'

export type AddressBookEntry = funtypes.Static<typeof AddressBookEntry>
export const AddressBookEntry = funtypes.Union(
	ActiveAddressEntry,
	ContactEntry,
	Erc20TokenEntry,
	Erc721Entry,
	Erc1155Entry,
	ContractEntry,
)

export type AddressBookEntries = funtypes.Static<typeof AddressBookEntries>
export const AddressBookEntries = funtypes.ReadonlyArray(AddressBookEntry)

export type IncompleteAddressBookEntry = {
	addingAddress: boolean, // if false, we are editing addess
	type: 'activeAddress' | 'contact' | 'contract' | 'ERC20' | 'ERC1155' | 'ERC721'
	address: string | undefined
	askForAddressAccess: boolean
	name: string | undefined
	symbol: string | undefined
	decimals: bigint | undefined
	logoUri: string | undefined
	entrySource: EntrySource
}

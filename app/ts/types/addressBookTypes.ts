import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'

export type ChainIdWithUniversal = funtypes.Static<typeof ChainIdWithUniversal>
export const ChainIdWithUniversal = funtypes.Union(EthereumQuantity, funtypes.Literal('AllChains'))

export type EntrySource = funtypes.Static<typeof EntrySource>
export const EntrySource = funtypes.Union(
	funtypes.Literal('DarkFloristMetadata'),
	funtypes.Literal('User'),
	funtypes.Literal('Interceptor'),
	funtypes.Literal('OnChain'),
	funtypes.Literal('FilledIn'),
)

export type DeclarativeNetRequestBlockMode = funtypes.Static<typeof DeclarativeNetRequestBlockMode>
export const DeclarativeNetRequestBlockMode = funtypes.Union(funtypes.Literal('block-all'), funtypes.Literal('disabled'))

const sharedAddressBookEntryOptionalFields = {
	logoUri: funtypes.String,
	abi: funtypes.String,
	useAsActiveAddress: funtypes.Boolean,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
	declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode,
	chainId: ChainIdWithUniversal,
}

const protocolAddressBookEntryOptionalFields = {
	protocol: funtypes.String,
	...sharedAddressBookEntryOptionalFields,
}

const nftAddressBookEntryOptionalFields = {
	watchedTokenIds: funtypes.ReadonlyArray(EthereumQuantity),
	...protocolAddressBookEntryOptionalFields,
}

export type Erc20TokenEntry = funtypes.Static<typeof Erc20TokenEntry>
export const Erc20TokenEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC20'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	...sharedAddressBookEntryOptionalFields,
}))

export type Erc721Entry = funtypes.Static<typeof Erc721Entry>
export const Erc721Entry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC721'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	entrySource: EntrySource,
}).And(funtypes.Partial({
	...nftAddressBookEntryOptionalFields,
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
	...nftAddressBookEntryOptionalFields,
}))

export type ContactEntry = funtypes.Static<typeof ContactEntry>
export const ContactEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('contact'),
	name: funtypes.String,
	address: EthereumAddress,
	entrySource: funtypes.Union(EntrySource, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'User' as const))),
}).And(funtypes.Partial({
	...sharedAddressBookEntryOptionalFields,
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
	...protocolAddressBookEntryOptionalFields,
}))

export type SafeEntry = funtypes.Static<typeof SafeEntry>
export const SafeEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('safe'),
	name: funtypes.String,
	address: EthereumAddress,
	chainId: EthereumQuantity,
	entrySource: EntrySource,
	useAsActiveAddress: funtypes.Boolean,
}).And(funtypes.Partial({
	safeSignerAddress: EthereumAddress,
	safeSignerAddresses: funtypes.ReadonlyArray(EthereumAddress),
	safeVersion: funtypes.String,
	logoUri: funtypes.String,
	abi: funtypes.String,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
	declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode,
}))

export type AddressBookEntryCategory = 'contact' | 'activeAddress' | 'ERC20' | 'ERC721' | 'contract' | 'ERC1155' | 'safe'

export type AddressBookEntry = ContactEntry | Erc20TokenEntry | Erc721Entry | Erc1155Entry | ContractEntry | SafeEntry
export const AddressBookEntry: funtypes.Runtype<AddressBookEntry> = funtypes.Union(
	ContactEntry,
	Erc20TokenEntry,
	Erc721Entry,
	Erc1155Entry,
	ContractEntry,
	SafeEntry,
)

export type SafeEntryWithSafeSigner = SafeEntry & { readonly safeSignerAddress: EthereumAddress }

export function isSafeEntryWithSafeSigner(entry: AddressBookEntry | undefined): entry is SafeEntryWithSafeSigner {
	return entry?.type === 'safe' && entry.safeSignerAddress !== undefined
}

export function getConfiguredSafeSigningEntry(
	entries: readonly AddressBookEntry[],
	settings: {
		readonly simulationMode: boolean
		readonly useSignersAddressAsActiveAddress: boolean
		readonly activeSimulationAddress: EthereumAddress | undefined
		readonly chainId: bigint | undefined
	},
): SafeEntryWithSafeSigner | undefined {
	if (
		settings.simulationMode
		|| settings.useSignersAddressAsActiveAddress
		|| settings.activeSimulationAddress === undefined
		|| settings.chainId === undefined
	) return undefined
	return entries.find((entry): entry is SafeEntryWithSafeSigner =>
		entry.address === settings.activeSimulationAddress
		&& entry.chainId === settings.chainId
		&& isSafeEntryWithSafeSigner(entry)
	)
}

export function getSafeSignerAddresses(entry: SafeEntry) {
	const configuredSigners = Array.from(new Set(entry.safeSignerAddresses ?? []))
	if (entry.safeSignerAddress === undefined || configuredSigners.includes(entry.safeSignerAddress)) return configuredSigners
	return [...configuredSigners, entry.safeSignerAddress]
}

export type AddressBookEntries = readonly AddressBookEntry[]
export const AddressBookEntries: funtypes.Runtype<AddressBookEntries> = funtypes.ReadonlyArray(AddressBookEntry)

export type AddressBookEntryType = funtypes.Static<typeof AddressBookEntryType>
export const AddressBookEntryType = funtypes.Union(funtypes.Literal('contact'), funtypes.Literal('contract'), funtypes.Literal('ERC20'), funtypes.Literal('ERC1155'), funtypes.Literal('ERC721'), funtypes.Literal('safe'))

export type IncompleteAddressBookEntry = funtypes.Static<typeof IncompleteAddressBookEntry>
export const IncompleteAddressBookEntry = funtypes.ReadonlyObject({
	addingAddress: funtypes.Boolean, // if false, we are editing addess
	type: AddressBookEntryType,
	address: funtypes.Union(funtypes.String, funtypes.Undefined),
	askForAddressAccess: funtypes.Boolean,
	name: funtypes.Union(funtypes.String, funtypes.Undefined),
	symbol: funtypes.Union(funtypes.String, funtypes.Undefined),
	decimals: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	logoUri: funtypes.Union(funtypes.String, funtypes.Undefined),
	entrySource: EntrySource,
	abi: funtypes.Union(funtypes.String, funtypes.Undefined),
	useAsActiveAddress: funtypes.Union(funtypes.Undefined, funtypes.Boolean),
	declarativeNetRequestBlockMode: funtypes.Union(funtypes.Undefined, DeclarativeNetRequestBlockMode),
	chainId: ChainIdWithUniversal,
}).And(funtypes.ReadonlyPartial({
	safeSignerAddress: funtypes.String,
	safeSignerAddresses: funtypes.ReadonlyArray(funtypes.String),
	safeVersion: funtypes.String,
}))

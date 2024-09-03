import { addressString } from '../utils/bigint.js'
import { AddressBookEntries, AddressBookEntry, ContactEntry, ContractEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'
import { tokenMetadata, contractMetadata, ContractDefinition, TokenDefinition, Erc721Definition, erc721Metadata, erc1155Metadata, Erc1155Definition } from '@darkflorist/address-metadata'
import { AddressBookCategory, GetAddressBookDataFilter } from '../types/interceptor-messages.js'
import { getFullLogoUri } from './metadataUtils.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntries } from './storageVariables.js'

type PartialResult = {
	bestMatchLength: number,
	locationOfBestMatch: number,
}

function fuzzyCompare(pattern: RegExp, searchQuery: string, lowerCasedName: string, address: string) {
	const regexpMatch = bestMatch(lowerCasedName.match(pattern))
	const addressMatch = address.includes(searchQuery) ? searchQuery : ''
	const bestMatchString = regexpMatch === undefined || addressMatch.length > regexpMatch.length ? addressMatch : regexpMatch
	if (bestMatchString.length === 0) return undefined
	return {
		bestMatchLength: bestMatchString.length,
		locationOfBestMatch: lowerCasedName.indexOf(bestMatchString)
	}
}

function bestMatch(matches: RegExpMatchArray | null) {
	if (matches) return [...matches].sort((a, b) => b.length - a.length )[0]
	return undefined
}

function search<ElementType>(searchArray: readonly ElementType[], searchFunction: (elementType: ElementType) => { comparison: PartialResult | undefined, entry: ElementType }) {
	const results = searchArray.map((x) => searchFunction(x))
	const undefinedRemoved = results.filter((searchResult): searchResult is { comparison: PartialResult, entry: ElementType } => searchResult.comparison !== undefined)
	return undefinedRemoved.sort((a, b) => (a.comparison.bestMatchLength - b.comparison.bestMatchLength) || (a.comparison.locationOfBestMatch - b.comparison.locationOfBestMatch)).map((x) => x.entry)
}

const convertTokenDefinitionToAddressBookEntry = ([address, def]: [string, TokenDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'ERC20' as const,
	entrySource: 'DarkFloristMetadata' as const,
})

const convertErc721DefinitionToAddressBookEntry = ([address, def]: [string, Erc721Definition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'ERC721' as const,
	entrySource: 'DarkFloristMetadata' as const,
})

const convertErc1155DefinitionToAddressBookEntry = ([address, def]: [string, Erc1155Definition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'ERC1155' as const,
	entrySource: 'DarkFloristMetadata' as const,
	decimals: undefined,
})

const convertContractDefinitionToAddressBookEntry = ([address, def]: [string, ContractDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'contract' as const,
	entrySource: 'DarkFloristMetadata' as const,
})

function concatArraysUniqueByAddress<T>(addTo: readonly (T & { address: bigint })[], addFrom: readonly (T & { address: bigint })[]) {
	const existingValues = new Set(addTo.map(item => addressString(item.address)))
	const uniqueItems = addFrom.filter(item => !existingValues.has(addressString(item.address)))
	return [...addTo, ...uniqueItems]
}

async function filterAddressBookDataByCategoryAndSearchString(addressBookCategory: AddressBookCategory, searchString: string | undefined): Promise<AddressBookEntries> {
	const unicodeEscapeString = (input: string) => `\\u{${ input.charCodeAt(0).toString(16) }}`
	const trimmedSearch = searchString !== undefined && searchString.trim().length > 0 ? searchString.trim() : undefined
	const searchPattern = trimmedSearch ? new RegExp(`(?=(${ trimmedSearch.split('').map(unicodeEscapeString).join('.*?') }))`, 'ui') : undefined
	const searchingDisabled = trimmedSearch === undefined || searchPattern === undefined
	const userEntries = (await getUserAddressBookEntries()).filter((entry) => entry.entrySource !== 'OnChain')
	switch(addressBookCategory) {
		case 'My Contacts': {
			const entries = userEntries.filter((entry): entry is ContactEntry => entry.type === 'contact')
			if (searchingDisabled) return entries
			const searchFunction = (entry: ContactEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'My Active Addresses': {
			const entries = userEntries.filter((entry) => entry.useAsActiveAddress === true)
			if (searchingDisabled) return entries
			const searchFunction = (entry: AddressBookEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'ERC1155 Tokens': {
			const entries = concatArraysUniqueByAddress(userEntries.filter((entry): entry is Erc1155Entry => entry.type === 'ERC1155'), Array.from(erc1155Metadata).map(convertErc1155DefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc1155Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'ERC20 Tokens': {
			const entries = concatArraysUniqueByAddress(userEntries.filter((entry): entry is Erc20TokenEntry => entry.type === 'ERC20'), Array.from(tokenMetadata).map(convertTokenDefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc20TokenEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol} ${ entry.name}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'Non Fungible Tokens': {
			const entries = concatArraysUniqueByAddress(userEntries.filter((entry): entry is Erc721Entry => entry.type === 'ERC721'), Array.from(erc721Metadata).map(convertErc721DefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc721Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol} ${ entry.name}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'Other Contracts': {
			const entries = concatArraysUniqueByAddress(userEntries.filter((entry): entry is ContractEntry => entry.type === 'contract'), Array.from(contractMetadata).map(convertContractDefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: ContractEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ 'protocol' in entry && entry.protocol !== undefined ? entry.protocol : ''} ${ entry.name }`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		default: assertNever(addressBookCategory)
	}
}

export async function getMetadataForAddressBookData(filter: GetAddressBookDataFilter) {
	const filtered = await filterAddressBookDataByCategoryAndSearchString(filter.filter, filter.searchString)
	return {
		entries: filtered.slice(filter.startIndex, filter.maxIndex),
		maxDataLength: filtered.length,
	}
}

export async function findEntryWithSymbolOrName(symbol: string | undefined, name: string | undefined): Promise<AddressBookEntry | undefined> {
	const lowerCasedName = name?.toLowerCase()
	const lowerCasedSymbol = symbol?.toLowerCase()

	const lowerCasedEqual = (nonLowerCased: string, lowerCased: string | undefined) => nonLowerCased.toLowerCase() === lowerCased

	const tokenMetadataEntry = Array.from(tokenMetadata).find((entry) => lowerCasedEqual(entry[1].symbol, lowerCasedSymbol) || lowerCasedEqual(entry[1].name, lowerCasedName))
	if (tokenMetadataEntry !== undefined) return convertTokenDefinitionToAddressBookEntry(tokenMetadataEntry)

	const erc721MetadataEntry = Array.from(erc721Metadata).find((entry) => lowerCasedEqual(entry[1].symbol, lowerCasedSymbol) || lowerCasedEqual(entry[1].name.toLowerCase(), lowerCasedName))
	if (erc721MetadataEntry !== undefined) return convertErc721DefinitionToAddressBookEntry(erc721MetadataEntry)

	const erc1155MetadataEntry = Array.from(erc1155Metadata).find((entry) => lowerCasedEqual(entry[1].symbol, lowerCasedSymbol) || lowerCasedEqual(entry[1].name.toLowerCase(), lowerCasedName))
	if (erc1155MetadataEntry !== undefined) return convertErc1155DefinitionToAddressBookEntry(erc1155MetadataEntry)

	const contractMetadataEntry = Array.from(contractMetadata).find((entry) => lowerCasedEqual(entry[1].name, lowerCasedName))
	if (contractMetadataEntry !== undefined) return convertContractDefinitionToAddressBookEntry(contractMetadataEntry)

	const userEntries = await getUserAddressBookEntries()
	const userEntry = userEntries.find((entry) => ('symbol' in entry && lowerCasedEqual(entry.symbol, lowerCasedSymbol)) || lowerCasedEqual(entry.name, lowerCasedName))
	if (userEntry !== undefined) return userEntry
	
	return undefined
}

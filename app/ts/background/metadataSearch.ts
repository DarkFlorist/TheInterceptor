import { addressString } from '../utils/bigint.js'
import type { AddressBookEntries, AddressBookEntry, ChainIdWithUniversal, ContactEntry, ContractEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'
import type { ContractDefinition, TokenDefinition, Erc721Definition, Erc1155Definition } from '@darkflorist/address-metadata'
import type { AddressBookCategory, GetAddressBookDataFilter } from '../types/interceptor-messages.js'
import { getFullLogoUri } from './metadataUtils.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntriesForChainId, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { createFuzzySearchPattern } from '../utils/fuzzySearch.js'
import { getBundledContractMetadata, getBundledErc1155Metadata, getBundledErc721Metadata, getBundledTokenMetadata, listBundledContractMetadata, listBundledErc1155Metadata, listBundledErc721Metadata, listBundledTokenMetadata, listEveryBundledContractMetadata, listEveryBundledErc1155Metadata, listEveryBundledErc721Metadata, listEveryBundledTokenMetadata } from './bundledMetadataLookup.js'

type PartialResult = {
	bestMatchLength: number,
	locationOfBestMatch: number,
}

function fuzzyCompare(pattern: RegExp, searchQuery: string, lowerCasedName: string, address: string) {
	const regexpMatch = bestMatch(lowerCasedName.match(pattern))
	const addressMatch = address.toLowerCase().includes(searchQuery.toLowerCase()) ? searchQuery.toLowerCase() : ''
	const bestMatchString = regexpMatch === undefined || addressMatch.length > regexpMatch.length ? addressMatch : regexpMatch
	if (bestMatchString.length === 0) return undefined
	return {
		bestMatchLength: bestMatchString.length,
		locationOfBestMatch: lowerCasedName.indexOf(bestMatchString)
	}
}

export function bestMatch(matches: RegExpMatchArray | null) {
	if (matches) return [...matches].sort((a, b) => b.length - a.length )[0]
	return undefined
}

const compareMatches = (a: PartialResult, b: PartialResult) => (a.bestMatchLength - b.bestMatchLength) || (a.locationOfBestMatch - b.locationOfBestMatch)

function search<ElementType, EntryType>(searchArray: readonly ElementType[], searchFunction: (elementType: ElementType) => { comparison: PartialResult | undefined, entry: EntryType }) {
	const results = searchArray.map((x) => searchFunction(x))
	const undefinedRemoved = results.filter((searchResult): searchResult is { comparison: PartialResult, entry: EntryType } => searchResult.comparison !== undefined)
	return undefinedRemoved.sort((a, b) => compareMatches(a.comparison, b.comparison)).map((x) => x.entry)
}

const convertTokenDefinitionToAddressBookEntry = ([address, def]: [string, TokenDefinition]) => {
	const { logoUri, ...rest } = def
	return {
		...rest,
		...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
		address: BigInt(address),
		type: 'ERC20' as const,
		entrySource: 'DarkFloristMetadata' as const,
	}
}

const convertErc721DefinitionToAddressBookEntry = ([address, def]: [string, Erc721Definition]) => {
	const { logoUri, ...rest } = def
	return {
		...rest,
		...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
		address: BigInt(address),
		type: 'ERC721' as const,
		entrySource: 'DarkFloristMetadata' as const,
	}
}

const convertErc1155DefinitionToAddressBookEntry = ([address, def]: [string, Erc1155Definition]) => {
	const { logoUri, ...rest } = def
	return {
		...rest,
		...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
		address: BigInt(address),
		type: 'ERC1155' as const,
		entrySource: 'DarkFloristMetadata' as const,
		decimals: undefined,
	}
}

const convertContractDefinitionToAddressBookEntry = ([address, def]: [string, ContractDefinition]) => {
	const { logoUri, ...rest } = def
	return {
		...rest,
		...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
		address: BigInt(address),
		type: 'contract' as const,
		entrySource: 'DarkFloristMetadata' as const,
	}
}

const getTokenSearchText = (token: { symbol: string, name: string }) => `${ token.symbol } ${ token.name }`
const getErc1155SearchText = (token: { name: string }) => token.name
const getContractSearchText = (contract: { name: string, protocol?: string | undefined }) => `${ contract.protocol ?? '' } ${ contract.name }`

type SearchableEntry<Entry> = { entry: Entry, searchTexts: readonly string[] }
type BundledCategoryListing<Definition> = { listed: Iterable<[string, Definition]>, every: Iterable<[string, Definition]> }

// Lists the user's entries, searchable by their own text, then each bundled address no user entry overrides, showing its canonical entry but searchable by every bundled entry of the address (see listEveryBundledTokenMetadata).
function listUserAndBundledEntries<Entry extends { address: bigint }, Definition>(userEntries: readonly Entry[], bundled: BundledCategoryListing<Definition> | undefined, convertDefinition: (bundledEntry: [string, Definition]) => Entry, getSearchText: (entryOrDefinition: Entry | Definition) => string): SearchableEntry<Entry>[] {
	const searchableUserEntries = userEntries.map((entry) => ({ entry, searchTexts: [getSearchText(entry)] }))
	if (bundled === undefined) return searchableUserEntries
	const searchTextsByAddress = new Map<string, string[]>()
	for (const [address, definition] of bundled.every) searchTextsByAddress.set(address, [...searchTextsByAddress.get(address) ?? [], getSearchText(definition)])
	const userAddresses = new Set(userEntries.map((entry) => addressString(entry.address)))
	// Every listed address is also in the full listing, so the fallback to the listed entry's own text only keeps the result typed.
	const searchableBundledEntries = Array.from(bundled.listed, ([address, definition]) => ({ entry: convertDefinition([address, definition]), searchTexts: searchTextsByAddress.get(address) ?? [getSearchText(definition)] }))
	return [...searchableUserEntries, ...searchableBundledEntries.filter(({ entry }) => !userAddresses.has(addressString(entry.address)))]
}

// Ranks each entry by whichever of its search texts matches best; without a search the entries keep their listing order.
function searchEntries<Entry extends { address: bigint }>(searchableEntries: readonly SearchableEntry<Entry>[], searchPattern: RegExp | undefined, searchQuery: string | undefined): Entry[] {
	if (searchPattern === undefined || searchQuery === undefined) return searchableEntries.map(({ entry }) => entry)
	const searchFunction = ({ entry, searchTexts }: SearchableEntry<Entry>) => ({
		comparison: searchTexts.map((searchText) => fuzzyCompare(searchPattern, searchQuery, searchText, addressString(entry.address))).filter((comparison) => comparison !== undefined).sort(compareMatches)[0],
		entry,
	})
	return search(searchableEntries, searchFunction)
}

// Returns the first address in map order with a matching bundled entry, shadowed ones included, together with its canonical entry, so a duplicate name warning shows the token as the address book lists it.
function findBundledEntry<Definition>(everyEntry: Iterable<[string, Definition]>, getCanonicalEntry: (address: bigint) => Definition | undefined, isMatch: (definition: Definition) => boolean): [string, Definition] | undefined {
	for (const [address, definition] of everyEntry) {
		// Every bundled address has a canonical entry, so the fallback to the matched entry only keeps the result typed.
		if (isMatch(definition)) return [address, getCanonicalEntry(BigInt(address)) ?? definition]
	}
	return undefined
}

async function filterAddressBookDataByCategoryAndSearchString(addressBookCategory: AddressBookCategory, searchString: string | undefined, chainId: ChainIdWithUniversal): Promise<AddressBookEntries> {
	const trimmedSearch = searchString !== undefined && searchString.trim().length > 0 ? searchString.trim() : undefined
	const searchPattern = trimmedSearch === undefined ? undefined : createFuzzySearchPattern(trimmedSearch)
	const searchingDisabled = trimmedSearch === undefined || searchPattern === undefined
	const userEntries = (await getUserAddressBookEntriesForChainId(chainId)).filter((entry) => entry.entrySource !== 'OnChain')
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
		case 'My Safes': {
			const entries = userEntries.filter((entry) => entry.type === 'safe')
			if (searchingDisabled) return entries
			const searchFunction = (entry: AddressBookEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'ERC1155 Tokens': {
			const filteredUserEntries = userEntries.filter((entry): entry is Erc1155Entry => entry.type === 'ERC1155')
			const bundled = chainId === 1n ? { listed: listBundledErc1155Metadata(), every: listEveryBundledErc1155Metadata() } : undefined
			return searchEntries(listUserAndBundledEntries(filteredUserEntries, bundled, convertErc1155DefinitionToAddressBookEntry, getErc1155SearchText), searchPattern, trimmedSearch)
		}
		case 'ERC20 Tokens': {
			const filteredUserEntries = userEntries.filter((entry): entry is Erc20TokenEntry => entry.type === 'ERC20')
			const bundled = chainId === 1n ? { listed: listBundledTokenMetadata(), every: listEveryBundledTokenMetadata() } : undefined
			return searchEntries(listUserAndBundledEntries(filteredUserEntries, bundled, convertTokenDefinitionToAddressBookEntry, getTokenSearchText), searchPattern, trimmedSearch)
		}
		case 'Non Fungible Tokens': {
			const filteredUserEntries = userEntries.filter((entry): entry is Erc721Entry => entry.type === 'ERC721')
			const bundled = chainId === 1n ? { listed: listBundledErc721Metadata(), every: listEveryBundledErc721Metadata() } : undefined
			return searchEntries(listUserAndBundledEntries(filteredUserEntries, bundled, convertErc721DefinitionToAddressBookEntry, getTokenSearchText), searchPattern, trimmedSearch)
		}
		case 'Other Contracts': {
			const filteredUserEntries = userEntries.filter((entry): entry is ContractEntry => entry.type === 'contract')
			const bundled = chainId === 1n ? { listed: listBundledContractMetadata(), every: listEveryBundledContractMetadata() } : undefined
			return searchEntries(listUserAndBundledEntries(filteredUserEntries, bundled, convertContractDefinitionToAddressBookEntry, getContractSearchText), searchPattern, trimmedSearch)
		}
		default: assertNever(addressBookCategory)
	}
}

export async function getMetadataForAddressBookData(filter: GetAddressBookDataFilter) {
	const filtered = await filterAddressBookDataByCategoryAndSearchString(filter.filter, filter.searchString, filter.chainId)
	return {
		entries: filtered.slice(filter.startIndex, filter.maxIndex),
		maxDataLength: filtered.length,
	}
}

export async function findEntryWithSymbolOrName(symbol: string | undefined, name: string | undefined, chainId: ChainIdWithUniversal): Promise<AddressBookEntry | undefined> {
	const lowerCasedName = name?.toLowerCase()
	const lowerCasedSymbol = symbol?.toLowerCase()

	const lowerCasedEqual = (nonLowerCased: string, lowerCased: string | undefined) => nonLowerCased.toLowerCase() === lowerCased
	if (chainId === 'AllChains' || chainId === 1n) {
		const tokenMetadataEntry = findBundledEntry(listEveryBundledTokenMetadata(), getBundledTokenMetadata, (token) => lowerCasedEqual(token.symbol, lowerCasedSymbol) || lowerCasedEqual(token.name, lowerCasedName))
		if (tokenMetadataEntry !== undefined) return convertTokenDefinitionToAddressBookEntry(tokenMetadataEntry)

		const erc721MetadataEntry = findBundledEntry(listEveryBundledErc721Metadata(), getBundledErc721Metadata, (token) => lowerCasedEqual(token.symbol, lowerCasedSymbol) || lowerCasedEqual(token.name, lowerCasedName))
		if (erc721MetadataEntry !== undefined) return convertErc721DefinitionToAddressBookEntry(erc721MetadataEntry)

		const erc1155MetadataEntry = findBundledEntry(listEveryBundledErc1155Metadata(), getBundledErc1155Metadata, (token) => lowerCasedEqual(token.symbol, lowerCasedSymbol) || lowerCasedEqual(token.name, lowerCasedName))
		if (erc1155MetadataEntry !== undefined) return convertErc1155DefinitionToAddressBookEntry(erc1155MetadataEntry)

		const contractMetadataEntry = findBundledEntry(listEveryBundledContractMetadata(), getBundledContractMetadata, (contract) => lowerCasedEqual(contract.name, lowerCasedName))
		if (contractMetadataEntry !== undefined) return convertContractDefinitionToAddressBookEntry(contractMetadataEntry)
	}

	const userEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)
	const userEntry = userEntries.find((entry) => ('symbol' in entry && lowerCasedEqual(entry.symbol, lowerCasedSymbol)) || lowerCasedEqual(entry.name, lowerCasedName))
	if (userEntry !== undefined) return userEntry
	return undefined
}

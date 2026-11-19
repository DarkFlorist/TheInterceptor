import { addressString } from '../utils/bigint.js'
import type { AddressBookEntries, AddressBookEntry, ChainIdWithUniversal, ContactEntry, ContractEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../types/addressBookTypes.js'
import type { AddressBookCategory, GetAddressBookDataFilter } from '../types/interceptor-messages.js'
import { listBundledAddressBookEntriesForChain, listBundledAddressBookEntriesForNameCollisionCheck } from './bundledMetadata.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntriesForChainId, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { createFuzzySearchPattern } from '../utils/fuzzySearch.js'
import { removeEip3770ChainShortNameFromSearchQuery } from '../utils/addressValidation.js'

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

function search<ElementType>(searchArray: readonly ElementType[], searchFunction: (elementType: ElementType) => { comparison: PartialResult | undefined, entry: ElementType }) {
	const results = searchArray.map((x) => searchFunction(x))
	const undefinedRemoved = results.filter((searchResult): searchResult is { comparison: PartialResult, entry: ElementType } => searchResult.comparison !== undefined)
	return undefinedRemoved.sort((a, b) => (a.comparison.bestMatchLength - b.comparison.bestMatchLength) || (a.comparison.locationOfBestMatch - b.comparison.locationOfBestMatch)).map((x) => x.entry)
}

function concatArraysUniqueByAddress<T>(addTo: readonly (T & { address: bigint })[], addFrom: readonly (T & { address: bigint })[]) {
	const existingValues = new Set(addTo.map(item => addressString(item.address)))
	const uniqueItems = addFrom.filter(item => !existingValues.has(addressString(item.address)))
	return [...addTo, ...uniqueItems]
}

async function filterAddressBookDataByCategoryAndSearchString(addressBookCategory: AddressBookCategory, searchString: string | undefined, chainId: ChainIdWithUniversal): Promise<AddressBookEntries> {
	const trimmedSearch = searchString !== undefined && searchString.trim().length > 0 ? removeEip3770ChainShortNameFromSearchQuery(searchString.trim()) : undefined
	const searchPattern = trimmedSearch === undefined ? undefined : createFuzzySearchPattern(trimmedSearch)
	const searchingDisabled = trimmedSearch === undefined || searchPattern === undefined
	const userEntries = (await getUserAddressBookEntriesForChainId(chainId)).filter((entry) => entry.entrySource !== 'OnChain')
	const bundledEntries = listBundledAddressBookEntriesForChain(chainId)
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
			const entries = concatArraysUniqueByAddress(filteredUserEntries, bundledEntries.erc1155Tokens)
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc1155Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'ERC20 Tokens': {
			const filteredUserEntries = userEntries.filter((entry): entry is Erc20TokenEntry => entry.type === 'ERC20')
			const entries = concatArraysUniqueByAddress(filteredUserEntries, bundledEntries.erc20Tokens)
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc20TokenEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol} ${ entry.name}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'Non Fungible Tokens': {
			const filteredUserEntries = userEntries.filter((entry): entry is Erc721Entry => entry.type === 'ERC721')
			const entries = concatArraysUniqueByAddress(filteredUserEntries, bundledEntries.erc721Tokens)
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc721Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol} ${ entry.name}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'Other Contracts': {
			const filteredUserEntries = userEntries.filter((entry): entry is ContractEntry => entry.type === 'contract')
			const entries = concatArraysUniqueByAddress(filteredUserEntries, bundledEntries.contracts)
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
	const bundledEntries = listBundledAddressBookEntriesForNameCollisionCheck(chainId)
	const bundledEntry = bundledEntries.erc20Tokens.find((entry) => lowerCasedEqual(entry.symbol, lowerCasedSymbol) || lowerCasedEqual(entry.name, lowerCasedName))
		?? bundledEntries.erc721Tokens.find((entry) => lowerCasedEqual(entry.symbol, lowerCasedSymbol) || lowerCasedEqual(entry.name, lowerCasedName))
		?? bundledEntries.erc1155Tokens.find((entry) => lowerCasedEqual(entry.symbol, lowerCasedSymbol) || lowerCasedEqual(entry.name, lowerCasedName))
		?? bundledEntries.contracts.find((entry) => lowerCasedEqual(entry.name, lowerCasedName))
	if (bundledEntry !== undefined) return bundledEntry

	const userEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)
	const userEntry = userEntries.find((entry) => ('symbol' in entry && lowerCasedEqual(entry.symbol, lowerCasedSymbol)) || lowerCasedEqual(entry.name, lowerCasedName))
	if (userEntry !== undefined) return userEntry
	return undefined
}

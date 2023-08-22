import { addressString } from '../utils/bigint.js'
import { AddressBookEntries, AddressInfo, AddressInfoEntry, ContactEntry, ContractEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../utils/user-interface-types.js'
import { nftMetadata, tokenMetadata, contractMetadata, NftDefinition, ContractDefinition, TokenDefinition } from '@darkflorist/address-metadata'
import { AddressBookCategory, GetAddressBookDataFilter, UserAddressBook } from '../utils/interceptor-messages.js'
import { getFullLogoUri } from './metadataUtils.js'
<<<<<<< Updated upstream
=======
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntries } from './storageVariables.js'
>>>>>>> Stashed changes

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

const convertAddressInfoToAddressBookEntry = (info: AddressInfo) => ({
	...info,
	entrySource: 'DarkFloristMetadata' as const,
	type: 'addressInfo' as const
})

const convertTokenDefinitionToAddressBookEntry = ([address, def]: [string, TokenDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	entrySource: 'DarkFloristMetadata' as const,
	type: 'ERC20' as const,
})

const convertErc721DefinitionToAddressBookEntry = ([address, def]: [string, NftDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	entrySource: 'DarkFloristMetadata' as const,
	type: 'ERC721' as const,
})

const convertContractDefinitionToAddressBookEntry = ([address, def]: [string, ContractDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
<<<<<<< Updated upstream
	type: 'other contract' as const,
=======
	entrySource: 'DarkFloristMetadata' as const,
	type: 'contract' as const,
>>>>>>> Stashed changes
})

async function filterAddressBookDataByCategoryAndSearchString(addressBookCategory: AddressBookCategory, searchString: string | undefined, userAddressBook: UserAddressBook): Promise<AddressBookEntries> {
	const trimmedSearch = searchString !== undefined && searchString.trim().length > 0 ? searchString.trim().toLowerCase() : undefined
	const searchPattern = trimmedSearch ? new RegExp(`(?=(${ trimmedSearch.split('').join('.*?') }))`) : undefined
	const searchingDisabled = trimmedSearch === undefined || searchPattern === undefined

	const userBookEntries = await getUserAddressBookEntries()
	switch(addressBookCategory) {
		case 'My Contacts': {
			const entries = userBookEntries.filter((entry): entry is ContactEntry => entry.type === 'contact').concat(userAddressBook.contacts)
			if (searchingDisabled) return entries
			const searchFunction = (entry: ContactEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name.toLowerCase(), addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'My Active Addresses': {
			const entries = userBookEntries.filter((entry): entry is AddressInfoEntry => entry.type === 'addressInfo').concat(userAddressBook.addressInfos.map(convertAddressInfoToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: AddressInfoEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, entry.name.toLowerCase(), addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
<<<<<<< Updated upstream
		case 'Erc20Tokens': {
			if (searchingDisabled) return Array.from(tokenMetadata).map(convertTokenDefinitionToAddressBookEntry)
			const searchFunction = (element: [string, TokenDefinition]) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ element[1].symbol.toLowerCase()} ${ element[1].name.toLowerCase()}`, element[0]),
				element,
=======
		case 'ERC1155 Tokens': {
			const entries =  userBookEntries.filter((entry): entry is Erc1155Entry => entry.type === 'ERC1155')
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc1155Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol.toLowerCase()} ${ entry.name.toLowerCase()}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'ERC20 Tokens': {
			const entries = userBookEntries.filter((entry): entry is Erc20TokenEntry => entry.type === 'ERC20').concat(Array.from(tokenMetadata).map(convertTokenDefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc20TokenEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol.toLowerCase()} ${ entry.name.toLowerCase()}`, addressString(entry.address)),
				entry,
>>>>>>> Stashed changes
			})
			return search(entries, searchFunction)
		}
		case 'Non Fungible Tokens': {
			const entries = userBookEntries.filter((entry): entry is Erc721Entry => entry.type === 'ERC721').concat(Array.from(nftMetadata).map(convertErc721DefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: Erc721Entry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ entry.symbol.toLowerCase()} ${ entry.name.toLowerCase()}`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
		case 'Other Contracts': {
			const entries = userBookEntries.filter((entry): entry is ContractEntry => entry.type === 'contract').concat(Array.from(contractMetadata).map(convertContractDefinitionToAddressBookEntry))
			if (searchingDisabled) return entries
			const searchFunction = (entry: ContractEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ 'protocol' in entry && entry.protocol !== undefined ? entry.protocol.toLowerCase() : ''} ${ entry.name.toLowerCase() }`, addressString(entry.address)),
				entry,
			})
			return search(entries, searchFunction)
		}
	}
}

export async function getMetadataForAddressBookData(filter: GetAddressBookDataFilter, userAddressBook: UserAddressBook) {
	const filtered = await filterAddressBookDataByCategoryAndSearchString(filter.filter, filter.searchString, userAddressBook)
	return {
		entries: filtered.slice(filter.startIndex, filter.maxIndex),
		maxDataLength: filtered.length,
	}
}

import { addressString } from '../utils/bigint.js'
import { AddressBookEntries, AddressInfo, ContactEntry } from '../utils/user-interface-types.js'
import { nftMetadata, tokenMetadata, contractMetadata } from '@darkflorist/address-metadata'
import { AddressBookCategory, GetAddressBookDataFilter, UserAddressBook } from '../utils/interceptor-messages.js'
import { NftDefinition } from '@darkflorist/address-metadata/lib/nftMetadata.js'
import { ContractDefinition } from '@darkflorist/address-metadata/lib/contractMetadata.js'
import { TokenDefinition } from '@darkflorist/address-metadata/lib/tokenMetadata.js'
import { getFullLogoUri } from './metadataUtils.js'

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

function search<ElementType>(searchArray: readonly ElementType[], searchFunction: (elementType: ElementType) => { comparison: PartialResult | undefined, element: ElementType }) {
	const results = searchArray.map((x) => searchFunction(x))
	const undefinedRemoved = results.filter((searchResult): searchResult is { comparison: PartialResult, element: ElementType } => searchResult.comparison !== undefined)
	return undefinedRemoved.sort((a, b) => (a.comparison.bestMatchLength - b.comparison.bestMatchLength) || (a.comparison.locationOfBestMatch - b.comparison.locationOfBestMatch)).map((x) => x.element)
}

const convertAddressInfoToAddressBookEntry = (info: AddressInfo) => ({
	...info,
	type: 'addressInfo' as const
})

const convertTokenDefinitionToAddressBookEntry = ([address, def]: [string, TokenDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'token' as const,
})

const convertNftDefinitionToAddressBookEntry = ([address, def]: [string, NftDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'NFT' as const,
})

const convertContractDefinitionToAddressBookEntry = ([address, def]: [string, ContractDefinition]) => ({
	address: BigInt(address),
	...def,
	logoUri: def.logoUri ? `${ getFullLogoUri(def.logoUri) }` : undefined,
	type: 'other contract' as const,
})

function filterAddressBookDataByCategoryAndSearchString(addressBookCategory: AddressBookCategory, searchString: string | undefined, userAddressBook: UserAddressBook): AddressBookEntries {
	const trimmedSearch = searchString !== undefined && searchString.trim().length > 0 ? searchString.trim().toLowerCase() : undefined
	const searchPattern = trimmedSearch ? new RegExp(`(?=(${ trimmedSearch.split('').join('.*?') }))`) : undefined
	const searchingDisabled = trimmedSearch === undefined || searchPattern === undefined
	switch(addressBookCategory) {
		case 'My Contacts': {
			if (searchingDisabled) return userAddressBook.contacts
			const searchFunction = (element: ContactEntry) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, element.name.toLowerCase(), addressString(element.address)),
				element,
			})
			return search(userAddressBook.contacts, searchFunction)
		}
		case 'My Active Addresses': {
			if (searchingDisabled) return userAddressBook.addressInfos.map(convertAddressInfoToAddressBookEntry)
			const searchFunction = (element: AddressInfo) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, element.name.toLowerCase(), addressString(element.address)),
				element,
			})
			return search(userAddressBook.addressInfos, searchFunction).map(convertAddressInfoToAddressBookEntry)
		}
		case 'Tokens': {
			if (searchingDisabled) return Array.from(tokenMetadata).map(convertTokenDefinitionToAddressBookEntry)
			const searchFunction = (element: [string, TokenDefinition]) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ element[1].symbol.toLowerCase()} ${ element[1].name.toLowerCase()}`, element[0]),
				element,
			})
			return search(Array.from(tokenMetadata), searchFunction).map(convertTokenDefinitionToAddressBookEntry)
		}
		case 'Non Fungible Tokens': {
			if (searchingDisabled) return Array.from(nftMetadata).map(convertNftDefinitionToAddressBookEntry)
			const searchFunction = (element: [string, NftDefinition]) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ element[1].symbol.toLowerCase()} ${ element[1].name.toLowerCase()}`, element[0]),
				element,
			})
			return search(Array.from(nftMetadata), searchFunction).map(convertNftDefinitionToAddressBookEntry)
		}
		case 'Other Contracts': {
			if (searchingDisabled) return Array.from(contractMetadata).map(convertContractDefinitionToAddressBookEntry)
			const searchFunction = (element: [string, ContractDefinition]) => ({
				comparison: fuzzyCompare(searchPattern, trimmedSearch, `${ 'protocol' in element[1] && element[1].protocol !== undefined ? element[1].protocol.toLowerCase() : ''} ${ element[1].name.toLowerCase() }`, element[0]),
				element,
			})
			return search(Array.from(contractMetadata), searchFunction).map(convertContractDefinitionToAddressBookEntry)
		}
	}
}

export function getMetadataForAddressBookData(filter: GetAddressBookDataFilter, userAddressBook: UserAddressBook) {
	const filtered = filterAddressBookDataByCategoryAndSearchString(filter.filter, filter.searchString, userAddressBook)
	return {
		entries: filtered.slice(filter.startIndex, filter.maxIndex),
		maxDataLength: filtered.length,
	}
}

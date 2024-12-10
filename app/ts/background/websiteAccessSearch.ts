import { WebsiteAccessArray, WebsiteAccess, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { addressString } from '../utils/bigint.js'
import { bestMatch } from './medataSearch.js'

type SearchMatch = {
	length: number
	location: number
}

const createSearchPattern = (searchString: string) => {
	const unicodeEscapeString = (stringToEscape: string) => `\\u{${ stringToEscape.charCodeAt(0).toString(16) }}`
	const segments = searchString.trim().split('')
	return segments.length ? new RegExp(`(?=(${ segments.map(unicodeEscapeString).join('.*?') }))`, 'ui') : undefined
}

function computeSearchMatch(searchQuery: string, searchAgainst: string): SearchMatch | undefined {
	const pattern = createSearchPattern(searchQuery)
	if (!pattern) return undefined

	const matchedString = bestMatch(searchAgainst.match(pattern))
	if (!matchedString) return undefined

	return {
		length: matchedString.length,
		location: searchAgainst.indexOf(matchedString)
	}
}

function selectLongerMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined): T | undefined
function selectLongerMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined, defaultValue: T): T
function selectLongerMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined, defaultValue?: T): T | undefined {
	if (!a) return b ?? defaultValue
	if (!b) return a
	return a.length > b.length ? a : b
}

type SearchScore<T> = {
	entry: T
	score: number
}

function calculateWebsiteAccessScore(entry: WebsiteAccess, query: string): SearchScore<WebsiteAccess> {
	const urlMatch = computeSearchMatch(query, entry.website.websiteOrigin.toLowerCase())
	const titleMatch = entry.website.title ? computeSearchMatch(query, entry.website.title.toLowerCase()) : undefined
	const addressMatches = entry.addressAccess?.map((addr: WebsiteAddressAccess) => computeSearchMatch(query, addressString(addr.address).toLowerCase())) || []

	const bestResult = [urlMatch, titleMatch, ...addressMatches]
		.filter((x): x is NonNullable<typeof x> => x !== undefined)
		.reduce(selectLongerMatch, { length: 0, location: Infinity })

	return {
		entry,
		score: bestResult.length
	}
}

export const searchWebsiteAccess = (query: string, websiteAccess: WebsiteAccessArray): WebsiteAccessArray => {
	// return everything if query is empty or whitespace
	if (query.trim() === '') return websiteAccess

	return websiteAccess
		.map(entry => calculateWebsiteAccessScore(entry, query))
		.filter(result => result.score > 0)
		.sort((a, b) => b.score - a.score)
		.map(result => result.entry)
}

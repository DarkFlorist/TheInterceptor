import { WebsiteAccessArray, WebsiteAccess, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { addressString } from '../utils/bigint.js'
import { bestMatch } from './medataSearch.js'

type FuzzyMatchResult = {
	bestMatchLength: number
	locationOfBestMatch: number
}

const createSearchPattern = (searchString: string) => {
	const unicodeEscapeString = (stringToEscape: string) => `\\u{${ stringToEscape.charCodeAt(0).toString(16) }}`
	const segments = searchString.trim().split('')
	return segments.length ? new RegExp(`(?=(${ segments.map(unicodeEscapeString).join('.*?') }))`, 'ui') : undefined
}

function fuzzyCompare(searchQuery: string, text: string): FuzzyMatchResult | undefined {
	const pattern = createSearchPattern(searchQuery)
	if (!pattern) return undefined

	const fuzzyMatch = bestMatch(text.match(pattern))
	if (!fuzzyMatch) return undefined

	return {
		bestMatchLength: fuzzyMatch.length,
		locationOfBestMatch: text.indexOf(fuzzyMatch)
	}
}

function selectBestAddressMatch<T extends FuzzyMatchResult>(a: T | undefined, b: T | undefined): T | undefined {
	if (!a) return b
	if (!b) return a
	return a.bestMatchLength > b.bestMatchLength ? a : b
}

function selectBestMatchWithDefault<T extends FuzzyMatchResult>(a: T, b: T): T {
	return a.bestMatchLength > b.bestMatchLength ? a : b
}

function calculateWebsiteAccessScore(entry: WebsiteAccess, query: string): { entry: WebsiteAccess; score: number } {
	const urlMatch = fuzzyCompare(query, entry.website.websiteOrigin.toLowerCase())
	const titleMatch = entry.website.title ? fuzzyCompare(query, entry.website.title.toLowerCase()) : undefined
	const addressMatches = entry.addressAccess?.map((addr: WebsiteAddressAccess) => fuzzyCompare(query, addressString(addr.address).toLowerCase())) || []

	const bestAddressMatch = addressMatches.length > 0 ? addressMatches.reduce(selectBestAddressMatch) : undefined

	const bestResult = [urlMatch, titleMatch, bestAddressMatch]
		.filter((x): x is NonNullable<typeof x> => x !== undefined)
		.reduce(selectBestMatchWithDefault, { bestMatchLength: 0, locationOfBestMatch: 0 })

	return {
		entry,
		score: bestResult.bestMatchLength
	}
}

export const searchWebsiteAccess = (query: string, websiteAccess: WebsiteAccessArray): WebsiteAccessArray => {
	// return everything if query is empty or whitespace
	if (!query || query.trim() === '') return websiteAccess

	return websiteAccess
		.map(entry => calculateWebsiteAccessScore(entry, query))
		.filter(result => result.score > 0)
		.sort((a, b) => b.score - a.score)
		.map(result => result.entry)
}

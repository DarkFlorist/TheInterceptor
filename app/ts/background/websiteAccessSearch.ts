import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { addressString } from '../utils/bigint.js'
import { bestMatch } from './medataSearch.js'

const createSearchPattern = (searchString: string) => {
	const unicodeEscapeString = (stringToEscape: string) => `\\u{${ stringToEscape.charCodeAt(0).toString(16) }}`
	const segments = searchString.trim().split('')
	return segments.length ? new RegExp(`(?=(${ segments.map(unicodeEscapeString).join('.*?') }))`, 'ui') : undefined
}

function fuzzyCompare(searchQuery: string, text: string) {
	const pattern = createSearchPattern(searchQuery)
	if (!pattern) return undefined

	const fuzzyMatch = bestMatch(text.match(pattern))
	if (!fuzzyMatch) return undefined

	return {
		bestMatchLength: fuzzyMatch.length,
		locationOfBestMatch: text.indexOf(fuzzyMatch)
	}
}

export const searchWebsiteAccess = (
	query: string,
	websiteAccess: WebsiteAccessArray,
) => {
	// return everything if query is empty or whitespace
	if (!query || query.trim() === '') return websiteAccess

	return websiteAccess.map((entry) => {
		const urlMatch = fuzzyCompare(query, entry.website.websiteOrigin.toLowerCase())
		const titleMatch = entry.website.title
			? fuzzyCompare(query, entry.website.title.toLowerCase())
			: undefined
		const addressMatches = entry.addressAccess?.map(addr =>
			fuzzyCompare(query, addressString(addr.address).toLowerCase())
		) || []

		const bestAddressMatch = addressMatches.length > 0
			? addressMatches.reduce((a, b) => {
				if (!a) return b
				if (!b) return a
				return a.bestMatchLength > b.bestMatchLength ? a : b
			})
			: undefined

		const bestResult = [urlMatch, titleMatch, bestAddressMatch]
			.filter((x): x is NonNullable<typeof x> => x !== undefined)
			.reduce((a, b) => a.bestMatchLength > b.bestMatchLength ? a : b, { bestMatchLength: 0, locationOfBestMatch: 0 })

		return {
			entry,
			score: bestResult.bestMatchLength
		}
	})
	.filter(result => result.score > 0)
	.sort((a, b) => b.score - a.score)
	.map(result => result.entry)
}

import type { WebsiteAccessArray, WebsiteAccess, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { addressString } from '../utils/bigint.js'
import { createFuzzySearchPattern } from '../utils/fuzzySearch.js'

type SearchMatch = {
	length: number
	location: number
}

function computeSearchMatch(searchQuery: string, searchAgainst: string): SearchMatch | undefined {
	const fuzzyPattern = createFuzzySearchPattern(searchQuery)
	if (!fuzzyPattern) return undefined
	const pattern = new RegExp(fuzzyPattern.source, `${ fuzzyPattern.flags }g`)

	let bestResult: SearchMatch | undefined
	for (const match of searchAgainst.matchAll(pattern)) {
		const matchedString = match[1]
		if (matchedString === undefined || match.index === undefined) continue
		bestResult = selectBetterMatch(bestResult, { length: matchedString.length, location: match.index })
	}
	return bestResult
}

function selectBetterMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined): T | undefined
function selectBetterMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined, defaultValue: T): T
function selectBetterMatch<T extends SearchMatch>(a: T | undefined, b: T | undefined, defaultValue?: T): T | undefined {
	if (!a) return b ?? defaultValue
	if (!b) return a
	if (a.length !== b.length) return a.length < b.length ? a : b
	return a.location <= b.location ? a : b
}

type SearchScore<T> = {
	entry: T
	match: SearchMatch
}

function calculateWebsiteAccessScore(entry: WebsiteAccess, query: string): SearchScore<WebsiteAccess> {
	const urlMatch = computeSearchMatch(query, entry.website.websiteOrigin.toLowerCase())
	const titleMatch = entry.website.title ? computeSearchMatch(query, entry.website.title.toLowerCase()) : undefined
	const addressMatches = entry.addressAccess?.map((addr: WebsiteAddressAccess) => computeSearchMatch(query, addressString(addr.address).toLowerCase())) || []

	const bestResult = [urlMatch, titleMatch, ...addressMatches]
		.filter((x): x is NonNullable<typeof x> => x !== undefined)
		.reduce(selectBetterMatch, { length: Infinity, location: Infinity })

	return {
		entry,
		match: bestResult
	}
}

export const searchWebsiteAccess = (query: string, websiteAccess: WebsiteAccessArray): WebsiteAccessArray => {
	// return everything if query is empty or whitespace
	if (query.trim() === '') return websiteAccess

	return websiteAccess
		.map(entry => calculateWebsiteAccessScore(entry, query))
		.filter(result => Number.isFinite(result.match.length))
		.sort((a, b) => a.match.length - b.match.length || a.match.location - b.match.location)
		.map(result => result.entry)
}

import { SearchMetadata, SearchProximity } from '../types/interceptor-messages.js'
import { WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { EthereumAddress, serialize } from '../types/wire-types.js'

const computeSearchMetadata = ({ website, addressAccess }: WebsiteAccess, query: string): SearchMetadata => {
	const searchMeta = createSearchInstance(query)
	const connectedAddresses = addressAccess ? addressAccess.map(({ address }) => serialize(EthereumAddress, address)) : []

	const isValidTarget = (value: unknown): value is string => typeof value === 'string'
	searchMeta.targets = [website.websiteOrigin, website.title, ...connectedAddresses].filter(isValidTarget)

	return searchMeta
}

export function fuzzySearchWebsiteAccess(accessList: WebsiteAccessArray, query: string) {
	const metadata: Record<string, SearchMetadata> = {}
	const matches = query ? queryAccessList() : accessList

	function queryAccessList() {
		const matches = []
		for (const access of accessList) {
			const searchResult = computeSearchMetadata(access, query)
			if (searchResult.closestProximity < ([Infinity, Infinity] as const)) {
				matches.push(access)
				metadata[access.website.websiteOrigin] = searchResult
			}
		}

		matches.sort(closestMatchSorter)
		return matches
	}

	function closestMatchSorter(a: WebsiteAccess, b: WebsiteAccess) {
		const aProximity = metadata[a.website.websiteOrigin]?.closestProximity
		const bProximity = metadata[b.website.websiteOrigin]?.closestProximity

		if (!aProximity || !bProximity) return 0

		const [aLength, aIndex] = aProximity
		const [bLength, bIndex] = bProximity

		return aLength === bLength ? aIndex! - bIndex! : aLength! - bLength!
	}

	return { matches, metadata }
}

const createSearchInstance = (query: string): SearchMetadata => {
	return {
		_targets: [],
		closestProximity: [Infinity, Infinity] as const,
		scores: {},
		get targets() {
			return this._targets
		},
		set targets(values) {
			this._targets = values

			// compute scores and closest proximity
			for (const target of this._targets) {
				const targetProximity = computeProximity(query, target)
				if (targetProximity === undefined) continue
				if (targetProximity < this.closestProximity) this.closestProximity = targetProximity
				this.scores[target] = targetProximity
			}
		}
	}
}

function bestMatch(matches: RegExpMatchArray | null) {
	if (matches) return [...matches].sort((a, b) => b.length - a.length)[0]
	return undefined
}

const unicodeEscapeString = (input: string) => `\\u{${input.charCodeAt(0).toString(16)}}`

const createRegexPattern = (queryString: string) => {
	const query = queryString.trim().toLowerCase()
	return new RegExp(`(?=(${query.split('').map(unicodeEscapeString).join('.*?')}))`, 'ui')
}

function computeProximity(query: string, target: string): SearchProximity | undefined {
	const regexPattern = createRegexPattern(query)
	const bestMatchString = bestMatch(target.match(regexPattern))
	if (bestMatchString === undefined) return undefined

	return [bestMatchString.length, target.indexOf(bestMatchString)]
}

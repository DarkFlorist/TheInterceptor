import { WebsiteAccess, WebsiteAccessArray } from "../types/websiteAccessTypes.js"
import { EthereumAddress, serialize } from "../types/wire-types.js"

const injectSearchMetadata = (query: string, access: WebsiteAccess): WebsiteAccess & { _searchMetadata: SearchMetadata } => {
	const metadata = createSearchMetadata(query)

	metadata.targets.push(access.website.websiteOrigin)
	access.website.title && metadata.targets.push(access.website.title)

	if (access.addressAccess) {
		for (const { address } of access.addressAccess) {
			const addressString = serialize(EthereumAddress, address)
			metadata.targets.push(addressString)
		}
	}

	return { ...access, _searchMetadata: metadata }
}

export function searchWebsiteAccess(query: string, accessList: WebsiteAccessArray) {
	return accessList
		.map(access => injectSearchMetadata(query, access))
		.filter(({ _searchMetadata: _search }) => _search.scores.size > 0)
		.sort((a, b) => {
			if (!a._searchMetadata.closest || !b._searchMetadata.closest) return 0
			return a._searchMetadata.closest < b._searchMetadata.closest ? 1 : -1
		})
}

function bestMatch(matches: RegExpMatchArray | null) {
	if (matches) return [...matches].sort((a, b) => b.length - a.length)[0]
	return undefined
}

const createRegexPattern = (searchString: string) => {
	const sanitizeSpecialCharacters = (text: string) => text.replace(/[.*+?^${}()|\[\]\\]/, '\\$&')
	return new RegExp(`(?=(${searchString.split('').map(sanitizeSpecialCharacters).join('.*?')}))`)
}

type MatchProximity = [number, number]

function computeProximity(query: string, target: string): MatchProximity | undefined {
	const queryString = query.trim().toLowerCase()
	const regexPattern = createRegexPattern(queryString)

	const targetString = target.trim().toLowerCase()
	const bestMatchString = bestMatch(targetString.match(regexPattern))
	if (bestMatchString === undefined) return undefined

	return [bestMatchString.length, targetString.indexOf(bestMatchString)]
}

type SearchMetadata = {
	_targets: string[]
	_closest: MatchProximity | undefined
	targets: string[]
	scores: Map<string, MatchProximity>
	closest: MatchProximity | undefined
}

const createSearchMetadata = (query: string): SearchMetadata => {
	return {
		_targets: [],
		_closest: undefined,
		get targets() {
			return this._targets
		},
		set targets(values) {
			this._targets = values
		},
		get scores() {
			const scores = new Map<string, MatchProximity>()
			for (const target of this._targets) {
				const proximity = computeProximity(query, target)
				if (proximity === undefined) continue
				this._closest = this._closest && this._closest < proximity ? this._closest : proximity
				scores.set(target, proximity)
			}
			return scores
		},
		get closest() {
			return this._closest
		}
	}
}


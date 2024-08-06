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
		.sort((a, b) => { return a._searchMetadata.closest - b._searchMetadata.closest })
}

type SearchMetadata = {
	_targets: string[]
	_scores: Map<string, number>
	targets: string[]
	scores: Map<string, number>
	closest: number
}

const createSearchMetadata = (query: string): SearchMetadata => {
	return {
		_targets: [],
		_scores: new Map(),
		get targets() {
			return this._targets
		},
		set targets(values) {
			this._targets = values
		},
		get scores() {
			this._scores = new Map<string, number>()
			for (const target of this._targets) {
				const distance = getClosestDistance(query, target)
				if (distance === Infinity) continue
				this._scores.set(target, distance)
			}
			return this._scores
		},
		get closest(): number {
			let minDistance = Infinity
			for (const [_, distance] of this._scores) {
				if (distance >= minDistance) continue
				minDistance = distance
			}
			return minDistance
		}
	}
}

function getClosestDistance(query: string, target: string): number {
	const targetWords = target.toLowerCase().split(/[-.\s]+/)
	const sanitizedQuery = query.trim().toLowerCase()

	let minDistance = Infinity

	for (const targetWord of targetWords) {
		// start distance with 1 if search string is a fragment of the target
		if (targetWord.includes(sanitizedQuery)) minDistance = 1

		const distance = levenshteinDistance(sanitizedQuery, targetWord)

		// should not take the entire length of the query string to match
		if (distance === targetWord.length || distance >= query.length || distance >= minDistance) continue

		minDistance = distance
	}

	return minDistance
}

function levenshteinDistance(source: string, target: string): number {
	const memo: Map<string, number> = new Map()

	function computeDistance(sourceIndex: number, targetIndex: number): number {
		const key = `${sourceIndex},${targetIndex}`
		if (memo.has(key)) return memo.get(key)!

		if (sourceIndex === 0) return targetIndex
		if (targetIndex === 0) return sourceIndex

		const cost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1

		const deletion = computeDistance(sourceIndex - 1, targetIndex) + 1
		const insertion = computeDistance(sourceIndex, targetIndex - 1) + 1
		const substitution = computeDistance(sourceIndex - 1, targetIndex - 1) + cost

		const result = Math.min(deletion, insertion, substitution)
		memo.set(key, result)
		return result
	}

	return computeDistance(source.length, target.length)
}

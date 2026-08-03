export function createFuzzySearchPattern(searchString: string) {
	const segments = Array.from(searchString.trim())
	if (segments.length === 0) return undefined
	const unicodeEscapes = segments.map((segment) => {
		const codePoint = segment.codePointAt(0)
		if (codePoint === undefined) throw new Error('Cannot create a fuzzy search pattern from an empty character.')
		return `\\u{${ codePoint.toString(16) }}`
	})
	return new RegExp(`(?=(${ unicodeEscapes.join('.*?') }))`, 'ui')
}

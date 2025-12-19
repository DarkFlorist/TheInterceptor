
export function deduplicateByFunction<Element>(elements: Element[], uniqueIdentifier: (element: Element) => string): Element[] {
	const unique: Map<string, Element> = new Map()
	for (const element of elements) {
		const key = uniqueIdentifier(element)
		if (unique.has(key)) continue
		unique.set(key, element)
	}
	return Array.from(unique.values())
}


export function deduplicateByFunction<Element>(elements: Element[], uniqueIdentifier: (element: Element) => string): Element[] {
	const unique: Map<string, Element> = new Map()
	for (const element of elements) {
		const key = uniqueIdentifier(element)
		if (unique.has(key)) continue
		unique.set(key, element)
	}
	return Array.from(unique.values())
}

export function last<Element>(elements: readonly Element[]): Element | undefined {
	return elements.length === 0 ? undefined : elements[elements.length - 1]
}

// Each item is its own step: one failing item never holds back the items after it. Returns the failures, in order.
export async function runEachIndependently<Item>(items: readonly Item[], run: (item: Item) => Promise<unknown>) {
	const failures: unknown[] = []
	for (const item of items) {
		try {
			await run(item)
		} catch (error: unknown) {
			failures.push(error)
		}
	}
	return failures
}

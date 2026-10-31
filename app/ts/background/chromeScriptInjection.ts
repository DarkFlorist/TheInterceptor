type ChromeFileInjection = {
	readonly target: { readonly tabId: number } & ({ readonly frameIds: readonly number[], readonly documentIds?: never } | { readonly documentIds: readonly string[], readonly frameIds?: never })
	readonly world: 'MAIN' | 'ISOLATED'
	readonly files: readonly string[]
}
type ChromeInjectionResult = { readonly result: unknown, readonly documentId?: string }

// The Firefox polyfill types omit Chrome's MAIN world and documentIds (Chrome 106+).
// Chrome awaits the script's final promise automatically: https://developer.chrome.com/docs/extensions/reference/api/scripting#promises
// Keep capability detection, native invocation and result validation together at this API boundary.
export function getChromeFileInjector() {
	const scripting = browser.scripting
	if (scripting === undefined) return undefined
	const executeScript: unknown = Reflect.get(scripting, 'executeScript')
	if (typeof executeScript !== 'function') return undefined
	return async (injection: ChromeFileInjection): Promise<readonly ChromeInjectionResult[]> => {
		const results: unknown = await executeScript.call(scripting, injection)
		if (!Array.isArray(results)) throw new Error('Chrome script injection returned an invalid result array.')
		return results.map((entry: unknown) => {
			if (typeof entry !== 'object' || entry === null) throw new Error('Chrome script injection returned an invalid frame result.')
			if ('documentId' in entry && entry.documentId !== undefined && typeof entry.documentId !== 'string') throw new Error('Chrome script injection returned an invalid document ID.')
			return { result: 'result' in entry ? entry.result : undefined, ...('documentId' in entry && typeof entry.documentId === 'string' ? { documentId: entry.documentId } : {}) }
		})
	}
}

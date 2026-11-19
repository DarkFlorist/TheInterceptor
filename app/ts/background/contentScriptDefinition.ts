export type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
// The browser polyfill types do not expose Chrome's MAIN world or matchOriginAsFallback options.
export type FixedContentScript = RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED', matchOriginAsFallback: boolean }

const normalizeMatchPattern = (pattern: string) => pattern === 'file://*/*' ? 'file:///*' : pattern
const sameValues = (left: readonly string[] | undefined, right: readonly string[] | undefined) => (left ?? []).length === (right ?? []).length && (right ?? []).every((value) => left?.some((registered) => normalizeMatchPattern(registered) === normalizeMatchPattern(value)) === true)

// Chrome reports extension-relative file paths without the leading slash used at registration.
export function haveSameScriptFiles(registered: RegisteredContentScript, desired: FixedContentScript) {
	return (registered.js ?? []).length === (desired.js ?? []).length && (desired.js ?? []).every((file, index) => registered.js?.[index]?.replace(/^\//, '') === file.replace(/^\//, ''))
}

export function sameContentScript(registered: RegisteredContentScript, desired: FixedContentScript) {
	if (registered.id !== desired.id || !sameValues(registered.matches, desired.matches) || !sameValues(registered.excludeMatches, desired.excludeMatches)) return false
	if (!haveSameScriptFiles(registered, desired)) return false
	if (registered.runAt !== desired.runAt || registered.allFrames !== desired.allFrames) return false
	if ('matchOriginAsFallback' in registered && registered.matchOriginAsFallback !== desired.matchOriginAsFallback) return false
	const registeredWorld = 'world' in registered ? registered.world : 'ISOLATED'
	if (registeredWorld !== desired.world) return false
	return true
}

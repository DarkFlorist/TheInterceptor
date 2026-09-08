const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatibilityModeScriptPath = `${ inpageScriptDirectory }/metamaskCompatibilityMode.js`
export const metamaskCompatibilityModeGlobalSymbolKey = 'TheInterceptor.metamaskCompatibilityMode'
export const metamaskCompatibilityModeGlobalSymbolKeyMarker = '[[metamaskCompatibilityModeGlobalSymbolKey]]'
export const metamaskCompatibilityModeGlobalAssignmentMarker = '[[metamaskCompatibilityModeGlobalAssignment]]'

// These paths drive runtime registration, MV2 document-start generation, and bundler entrypoints; static manifest copies are validated against this list in contentScriptsUpdating.test.ts.
export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [
		...(metamaskCompatibilityMode ? [metamaskCompatibilityModeScriptPath] : []),
		pageWorldProviderScriptPath,
	]
}

export function getMetamaskCompatibilityModeGlobalAssignmentSource(metamaskCompatibilityMode: unknown) {
	const enabled = metamaskCompatibilityMode === true
	return `Reflect.set(globalThis, Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) }), ${ JSON.stringify(enabled) })`
}

export function getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode: unknown) {
	return [
		{ file: 'vendor/webextension-polyfill/dist/browser-polyfill.js' },
		{ file: `${ inpageScriptDirectory }/listenContentScript.js` },
		{ code: getMetamaskCompatibilityModeGlobalAssignmentSource(metamaskCompatibilityMode) },
		{ file: `${ inpageScriptDirectory }/document_start.js` },
	] as const
}

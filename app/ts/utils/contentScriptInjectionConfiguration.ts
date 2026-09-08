const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatibilityModeScriptPath = `${ inpageScriptDirectory }/metamaskCompatibilityMode.js`
export const metamaskCompatibilityModeGlobalSymbolKey = 'TheInterceptor.metamaskCompatibilityMode'
export const metamaskCompatibilityModeGlobalSymbolKeyMarker = '[[metamaskCompatibilityModeGlobalSymbolKey]]'

export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [
		...(metamaskCompatibilityMode ? [metamaskCompatibilityModeScriptPath] : []),
		pageWorldProviderScriptPath,
	]
}

export function getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode: unknown) {
	const enabled = metamaskCompatibilityMode === true
	return [
		{ file: 'vendor/webextension-polyfill/dist/browser-polyfill.js' },
		{ file: `${ inpageScriptDirectory }/listenContentScript.js` },
		{ code: `Reflect.set(globalThis, Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) }), ${ JSON.stringify(enabled) })` },
		{ file: `${ inpageScriptDirectory }/document_start.js` },
	] as const
}

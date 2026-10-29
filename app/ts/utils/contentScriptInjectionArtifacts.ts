const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatiblePageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage-metamask-compatibility.js`
const documentStartScriptPath = `${ inpageScriptDirectory }/document_start.js`
const metamaskCompatibleDocumentStartScriptPath = `${ inpageScriptDirectory }/document_start-metamask-compatibility.js`

// These paths drive runtime registration, MV2 document-start generation, and bundler entrypoints; static manifest copies are validated against this list in contentScriptsUpdating.test.ts.
export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [metamaskCompatibilityMode ? metamaskCompatiblePageWorldProviderScriptPath : pageWorldProviderScriptPath]
}

export function getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode: boolean) {
	return metamaskCompatibilityMode ? metamaskCompatibleDocumentStartScriptPath : documentStartScriptPath
}

export function getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode: unknown) {
	return [
		{ file: 'vendor/webextension-polyfill/dist/browser-polyfill.js' },
		{ file: `${ inpageScriptDirectory }/listenContentScript.js` },
		{ file: getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode === true) },
	] as const
}

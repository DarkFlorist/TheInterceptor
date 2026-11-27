import { INPAGE_SCRIPTS } from '../config/injectedScripts.js'

const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatiblePageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage-metamask-compatibility.js`
const documentStartScriptPath = `${ inpageScriptDirectory }/document_start.js`
const metamaskCompatibleDocumentStartScriptPath = `${ inpageScriptDirectory }/document_start-metamask-compatibility.js`

// These paths drive runtime registration and the bundler's inpage artifact generation; static manifest copies are validated against this list in contentScriptInjectionStrategy.test.ts.
export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [metamaskCompatibilityMode ? metamaskCompatiblePageWorldProviderScriptPath : pageWorldProviderScriptPath]
}

export function getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode: boolean) {
	return metamaskCompatibilityMode ? metamaskCompatibleDocumentStartScriptPath : documentStartScriptPath
}

// Chrome scripting takes extension-root paths with a leading slash.
export const asExtensionRootPaths = (scriptPaths: readonly string[]) => scriptPaths.map((scriptPath) => `/${ scriptPath }`)

export function getManifestV2IsolatedWorldInjections(metamaskCompatibilityMode: unknown) {
	return [
		{ file: 'vendor/webextension-polyfill/dist/browser-polyfill.js' },
		{ file: INPAGE_SCRIPTS.contentListener.slice(1) },
		{ file: getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode === true) },
	] as const
}

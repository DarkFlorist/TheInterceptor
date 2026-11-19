const inpageScriptDirectory = 'inpage/js'

const pageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage.js`
const metamaskCompatiblePageWorldProviderScriptPath = `${ inpageScriptDirectory }/inpage-metamask-compatibility.js`

// These paths drive runtime registration, page-world provider generation, and bundler entrypoints; static manifest copies are validated against this list in contentScriptsUpdating.test.ts.
export function getPageWorldScriptPaths(metamaskCompatibilityMode: boolean): readonly string[] {
	return [metamaskCompatibilityMode ? metamaskCompatiblePageWorldProviderScriptPath : pageWorldProviderScriptPath]
}

// The isolated-world bridge between the page-world provider and the background, the same script in every compatibility mode.
export const isolatedWorldScriptPaths: readonly string[] = ['vendor/webextension-polyfill/dist/browser-polyfill.js', `${ inpageScriptDirectory }/listenContentScript.js`, `${ inpageScriptDirectory }/listenContentScriptBootstrap.js`]

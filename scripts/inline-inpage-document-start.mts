import { getManifestV2DocumentStartScriptPath, getPageWorldScriptPaths } from '../app/ts/utils/contentScriptInjectionArtifacts.ts'
import { metamaskCompatibilityModeAtPageLoadMarker, pageWorldProviderScriptPathMarker, pageWorldProviderSourceMarker } from './content-script-injection-markers.mts'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quotedMarkerPattern = (marker: string) => new RegExp(`(['"])${ escapeRegExp(marker) }\\1`)
const metamaskCompatibilityModeAtPageLoadMarkerPattern = new RegExp(`false;?\\s*//\\s*${ escapeRegExp(metamaskCompatibilityModeAtPageLoadMarker) }`)

// Bundling drops comments, so build/bundler.mts fills this marker while Bun loads the provider source, before bundling.
export function inlineMetamaskCompatibilityModeAtPageLoad(source: string, metamaskCompatibilityMode: boolean) {
	if (!metamaskCompatibilityModeAtPageLoadMarkerPattern.test(source)) throw new Error('Could not find MetaMask compatibility mode at page load marker in inpage.js')
	return source.replace(metamaskCompatibilityModeAtPageLoadMarkerPattern, JSON.stringify(metamaskCompatibilityMode))
}

function getPageWorldProviderScriptPath(metamaskCompatibilityMode: boolean) {
	const pageWorldProviderScriptPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
	if (pageWorldProviderScriptPath === undefined) throw new Error('Page-world provider script path was missing')
	return pageWorldProviderScriptPath
}

// Replace template markers in one pass, so marker-like text inside the bundled provider stays literal.
export function inlineDocumentStartPageWorldProvider(documentStartSource: string, pageWorldProvider: { readonly source: string, readonly scriptPath: string }) {
	const replacements = [
		{ marker: pageWorldProviderSourceMarker, value: pageWorldProvider.source, description: 'page-world provider source' },
		{ marker: pageWorldProviderScriptPathMarker, value: pageWorldProvider.scriptPath, description: 'page-world provider script path' },
	]
	for (const replacement of replacements) if (!quotedMarkerPattern(replacement.marker).test(documentStartSource)) throw new Error(`Could not find ${ replacement.description } marker in document_start.js`)
	const values = new Map(replacements.map(({ marker, value }) => [marker, value]))
	const pattern = new RegExp(`(['"])(${ replacements.map(({ marker }) => escapeRegExp(marker)).join('|') })\\1`, 'g')
	return documentStartSource.replace(pattern, (_match: string, _quote: string, marker: string) => {
		const value = values.get(marker)
		if (value === undefined) throw new Error(`Unknown document-start marker: ${ marker }`)
		return JSON.stringify(value)
	})
}

// Every generated inpage artifact: per compatibility mode, the page-world provider that MV3 registers, and the MV2 document-start script that carries the same provider inline and by URL. getPageWorldProviderSource returns the classic provider already built for that mode.
export function generateInpageArtifacts(documentStartSource: string, getPageWorldProviderSource: (metamaskCompatibilityMode: boolean) => string) {
	return [false, true].flatMap((metamaskCompatibilityMode) => {
		const pageWorldProvider = { source: getPageWorldProviderSource(metamaskCompatibilityMode), scriptPath: getPageWorldProviderScriptPath(metamaskCompatibilityMode) }
		return [
			{ path: pageWorldProvider.scriptPath, metamaskCompatibilityMode, source: pageWorldProvider.source },
			{ path: getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode), metamaskCompatibilityMode, source: inlineDocumentStartPageWorldProvider(documentStartSource, pageWorldProvider) },
		]
	})
}

import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { getManifestV2DocumentStartScriptPath, getPageWorldScriptPaths } from '../app/ts/utils/contentScriptInjectionArtifacts.ts'
import { metamaskCompatibilityModeAtPageLoadMarker, pageWorldProviderScriptPathMarker, pageWorldProviderSourceMarker } from './content-script-injection-markers.mts'

const appDirectory = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'app')
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quotedMarkerPattern = (marker: string) => new RegExp(`(['"])${ escapeRegExp(marker) }\\1`)
const pageWorldProviderSourceMarkerPattern = quotedMarkerPattern(pageWorldProviderSourceMarker)
const pageWorldProviderScriptPathMarkerPattern = quotedMarkerPattern(pageWorldProviderScriptPathMarker)
const metamaskCompatibilityModeAtPageLoadMarkerPattern = new RegExp(`false;?\\s*//\\s*${ escapeRegExp(metamaskCompatibilityModeAtPageLoadMarker) }`)

export function inlineMetamaskCompatibilityModeAtPageLoad(source: string, metamaskCompatibilityMode: boolean) {
	if (!metamaskCompatibilityModeAtPageLoadMarkerPattern.test(source)) throw new Error('Could not find MetaMask compatibility mode at page load marker in inpage.js')
	return source.replace(metamaskCompatibilityModeAtPageLoadMarkerPattern, JSON.stringify(metamaskCompatibilityMode))
}

function getPageWorldProviderScriptPath(metamaskCompatibilityMode: boolean) {
	const pageWorldProviderScriptPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
	if (pageWorldProviderScriptPath === undefined) throw new Error('Page-world provider script path was missing')
	return pageWorldProviderScriptPath
}

// A replacer function keeps any $ sequence in the inlined value literal instead of reading it as a replacement pattern.
function replaceQuotedMarker(source: string, markerPattern: RegExp, markerDescription: string, value: string) {
	if (!markerPattern.test(source)) throw new Error(`Could not find ${ markerDescription } marker in document_start.js`)
	return source.replace(markerPattern, () => JSON.stringify(value))
}

export function inlineDocumentStartPageWorldProvider(documentStartSource: string, pageWorldProvider: { readonly source: string, readonly scriptPath: string }) {
	// The path goes in first so the source marker search never scans inlined provider code.
	const withProviderScriptPath = replaceQuotedMarker(documentStartSource, pageWorldProviderScriptPathMarkerPattern, 'page-world provider script path', pageWorldProvider.scriptPath)
	return replaceQuotedMarker(withProviderScriptPath, pageWorldProviderSourceMarkerPattern, 'page-world provider source', pageWorldProvider.source)
}

// Every generated inpage artifact: per compatibility mode, the page-world provider that MV3 registers, and the MV2 document-start script that carries the same provider inline and by URL.
export function generateInpageArtifacts(documentStartSource: string, inpageSource: string) {
	return [false, true].flatMap((metamaskCompatibilityMode) => {
		const pageWorldProvider = { source: inlineMetamaskCompatibilityModeAtPageLoad(inpageSource, metamaskCompatibilityMode), scriptPath: getPageWorldProviderScriptPath(metamaskCompatibilityMode) }
		return [
			{ path: pageWorldProvider.scriptPath, metamaskCompatibilityMode, source: pageWorldProvider.source },
			{ path: getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode), metamaskCompatibilityMode, source: inlineDocumentStartPageWorldProvider(documentStartSource, pageWorldProvider) },
		]
	})
}

async function inlineInpageScript() {
	const [documentStartSource, inpageSource] = await Promise.all([
		fs.readFile(path.join(appDirectory, getManifestV2DocumentStartScriptPath(false)), 'utf8'),
		fs.readFile(path.join(appDirectory, getPageWorldProviderScriptPath(false)), 'utf8'),
	])
	await Promise.all(generateInpageArtifacts(documentStartSource, inpageSource).map(async (artifact) => await fs.writeFile(path.join(appDirectory, artifact.path), artifact.source)))
}

if (import.meta.main) {
	inlineInpageScript().catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
}

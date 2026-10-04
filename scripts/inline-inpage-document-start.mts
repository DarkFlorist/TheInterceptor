import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { getPageWorldScriptPaths } from '../app/ts/config/contentScriptInjectionArtifacts.ts'
import { metamaskCompatibilityModeAtPageLoadMarker, pageWorldProviderScriptPathMarker } from './content-script-injection-markers.mts'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const documentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start.js')
const metamaskCompatibleDocumentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start-metamask-compatibility.js')
const inpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage.js')
const metamaskCompatibleInpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage-metamask-compatibility.js')
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pageWorldProviderScriptPathMarkerPattern = new RegExp(`(['"])${ escapeRegExp(pageWorldProviderScriptPathMarker) }\\1`)
const metamaskCompatibilityModeAtPageLoadMarkerPattern = new RegExp(`false;?\\s*//\\s*${ escapeRegExp(metamaskCompatibilityModeAtPageLoadMarker) }`)

export function inlineMetamaskCompatibilityModeAtPageLoad(source: string, metamaskCompatibilityMode: boolean) {
	if (!metamaskCompatibilityModeAtPageLoadMarkerPattern.test(source)) throw new Error('Could not find MetaMask compatibility mode at page load marker in inpage.js')
	return source.replace(metamaskCompatibilityModeAtPageLoadMarkerPattern, JSON.stringify(metamaskCompatibilityMode))
}

export function inlineDocumentStartInjectionConfiguration(documentStartSource: string, metamaskCompatibilityMode: boolean) {
	if (!pageWorldProviderScriptPathMarkerPattern.test(documentStartSource)) throw new Error('Could not find page-world provider script path marker in document_start.js')
	const pageWorldProviderScriptPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
	if (pageWorldProviderScriptPath === undefined) throw new Error('Page-world provider script path was missing')
	return documentStartSource.replace(pageWorldProviderScriptPathMarkerPattern, JSON.stringify(pageWorldProviderScriptPath))
}

async function inlineInpageScript() {
	const [documentStartSource, inpageSource] = await Promise.all([
		fs.readFile(documentStartPath, 'utf8'),
		fs.readFile(inpagePath, 'utf8'),
	])
	const updatedInpageSource = inlineMetamaskCompatibilityModeAtPageLoad(inpageSource, false)
	const updatedMetamaskCompatibleInpageSource = inlineMetamaskCompatibilityModeAtPageLoad(inpageSource, true)
	const updatedDocumentStartSource = inlineDocumentStartInjectionConfiguration(documentStartSource, false)
	const updatedMetamaskCompatibleDocumentStartSource = inlineDocumentStartInjectionConfiguration(documentStartSource, true)
	await Promise.all([
		fs.writeFile(documentStartPath, updatedDocumentStartSource),
		fs.writeFile(metamaskCompatibleDocumentStartPath, updatedMetamaskCompatibleDocumentStartSource),
		fs.writeFile(inpagePath, updatedInpageSource),
		fs.writeFile(metamaskCompatibleInpagePath, updatedMetamaskCompatibleInpageSource),
	])
}

if (import.meta.main) {
	inlineInpageScript().catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
}

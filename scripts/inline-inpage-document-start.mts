import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { getPageWorldScriptPaths, metamaskCompatibilityModeGlobalSymbolKey, metamaskCompatibilityModeGlobalSymbolKeyMarker } from '../app/ts/utils/contentScriptInjectionArtifacts.ts'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const documentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start.js')
const inpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage.js')
const injectedMarkerPattern = /injectScript\((['"])\[\[injected\.ts\]\]\1\)/
const pageWorldScriptPathsMarkerPattern = /(['"])\[\[pageWorldScriptPaths\]\]\1/
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern = new RegExp(`(['"])${ escapeRegExp(metamaskCompatibilityModeGlobalSymbolKeyMarker) }\\1`)

const pageWorldScriptPathsByCompatibilityMode = {
	disabled: getPageWorldScriptPaths(false),
	enabled: getPageWorldScriptPaths(true),
}

export function inlineContentScriptInjectionConfiguration(source: string, artifactName: string) {
	if (!metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern.test(source)) throw new Error(`Could not find MetaMask compatibility mode global symbol key marker in ${ artifactName }`)
	return source.replace(metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern, JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey))
}

export function inlineInpageSourceIntoDocumentStart(documentStartSource: string, inpageSource: string) {
	if (!injectedMarkerPattern.test(documentStartSource)) throw new Error('Could not find inpage injection marker in document_start.js')
	if (!pageWorldScriptPathsMarkerPattern.test(documentStartSource)) throw new Error('Could not find page-world script paths marker in document_start.js')
	const updatedInpageSource = inlineContentScriptInjectionConfiguration(inpageSource, 'inpage.js')
	return inlineContentScriptInjectionConfiguration(documentStartSource, 'document_start.js')
		.replace(pageWorldScriptPathsMarkerPattern, JSON.stringify(JSON.stringify(pageWorldScriptPathsByCompatibilityMode)))
		.replace(injectedMarkerPattern, `injectScript(${ JSON.stringify(updatedInpageSource) })`)
}

async function inlineInpageScript() {
	const metamaskCompatibilityModePath = path.join(projectRoot, 'app', 'inpage', 'js', 'metamaskCompatibilityMode.js')
	const [documentStartSource, inpageSource, metamaskCompatibilityModeSource] = await Promise.all([
		fs.readFile(documentStartPath, 'utf8'),
		fs.readFile(inpagePath, 'utf8'),
		fs.readFile(metamaskCompatibilityModePath, 'utf8'),
	])
	const updatedInpageSource = inlineContentScriptInjectionConfiguration(inpageSource, 'inpage.js')
	const updatedMetamaskCompatibilityModeSource = inlineContentScriptInjectionConfiguration(metamaskCompatibilityModeSource, 'metamaskCompatibilityMode.js')
	const updatedDocumentStartSource = inlineInpageSourceIntoDocumentStart(documentStartSource, inpageSource)
	await Promise.all([
		fs.writeFile(documentStartPath, updatedDocumentStartSource),
		fs.writeFile(inpagePath, updatedInpageSource),
		fs.writeFile(metamaskCompatibilityModePath, updatedMetamaskCompatibilityModeSource),
	])
}

if (import.meta.main) {
	inlineInpageScript().catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
}

import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { getMetamaskCompatibilityModeGlobalAssignmentSource, metamaskCompatibilityModeGlobalSymbolKey } from '../app/ts/config/contentScriptInjectionArtifacts.ts'
import { metamaskCompatibilityModeGlobalAssignmentMarker, metamaskCompatibilityModeGlobalSymbolKeyMarker } from './content-script-injection-markers.mts'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const documentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start.js')
const inpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage.js')
const pageWorldScriptSourcesMarkerPattern = /(['"])\[\[pageWorldScriptSources\]\]\1/
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern = new RegExp(`(['"])${ escapeRegExp(metamaskCompatibilityModeGlobalSymbolKeyMarker) }\\1`)
const metamaskCompatibilityModeGlobalAssignmentMarkerPattern = new RegExp(`(['"])${ escapeRegExp(metamaskCompatibilityModeGlobalAssignmentMarker) }\\1;?`)

export function inlineContentScriptInjectionConfiguration(source: string, artifactName: string) {
	if (!metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern.test(source)) throw new Error(`Could not find MetaMask compatibility mode global symbol key marker in ${ artifactName }`)
	return source.replace(metamaskCompatibilityModeGlobalSymbolKeyMarkerPattern, JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey))
}

export function inlineMetamaskCompatibilityModeGlobalAssignment(source: string) {
	if (!metamaskCompatibilityModeGlobalAssignmentMarkerPattern.test(source)) throw new Error('Could not find MetaMask compatibility mode global assignment marker in metamaskCompatibilityMode.js')
	return source.replace(metamaskCompatibilityModeGlobalAssignmentMarkerPattern, getMetamaskCompatibilityModeGlobalAssignmentSource(true))
}

export function inlineDocumentStartInjectionConfiguration(documentStartSource: string, inpageSource: string, metamaskCompatibilityModeSource: string) {
	if (!pageWorldScriptSourcesMarkerPattern.test(documentStartSource)) throw new Error('Could not find page-world script sources marker in document_start.js')
	const configuredInpageSource = inlineContentScriptInjectionConfiguration(inpageSource, 'inpage.js')
	const configuredMetamaskCompatibilityModeSource = inlineMetamaskCompatibilityModeGlobalAssignment(metamaskCompatibilityModeSource)
	const pageWorldScriptSourcesByCompatibilityMode = {
		disabled: configuredInpageSource,
		enabled: `${ configuredMetamaskCompatibilityModeSource }\n${ configuredInpageSource }`,
	}
	return inlineContentScriptInjectionConfiguration(documentStartSource, 'document_start.js')
		.replace(pageWorldScriptSourcesMarkerPattern, JSON.stringify(JSON.stringify(pageWorldScriptSourcesByCompatibilityMode)))
}

async function inlineInpageScript() {
	const metamaskCompatibilityModePath = path.join(projectRoot, 'app', 'inpage', 'js', 'metamaskCompatibilityMode.js')
	const [documentStartSource, inpageSource, metamaskCompatibilityModeSource] = await Promise.all([
		fs.readFile(documentStartPath, 'utf8'),
		fs.readFile(inpagePath, 'utf8'),
		fs.readFile(metamaskCompatibilityModePath, 'utf8'),
	])
	const updatedInpageSource = inlineContentScriptInjectionConfiguration(inpageSource, 'inpage.js')
	const updatedMetamaskCompatibilityModeSource = inlineMetamaskCompatibilityModeGlobalAssignment(metamaskCompatibilityModeSource)
	const updatedDocumentStartSource = inlineDocumentStartInjectionConfiguration(documentStartSource, inpageSource, metamaskCompatibilityModeSource)
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

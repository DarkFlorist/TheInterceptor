import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { getPageWorldScriptPaths } from '../app/ts/utils/contentScriptInjectionArtifacts.ts'
import { metamaskCompatibilityModeAtPageLoadMarker } from './content-script-injection-markers.mts'

const appDirectory = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'app')
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

// Every generated inpage artifact: per compatibility mode, the page-world provider that Chrome (MV3) and Firefox (MV2) register as a MAIN-world content script.
export function generatePageWorldProviders(inpageSource: string) {
	return [false, true].map((metamaskCompatibilityMode) => ({
		path: getPageWorldProviderScriptPath(metamaskCompatibilityMode),
		metamaskCompatibilityMode,
		source: inlineMetamaskCompatibilityModeAtPageLoad(inpageSource, metamaskCompatibilityMode),
	}))
}

async function writePageWorldProviders() {
	const inpageSource = await fs.readFile(path.join(appDirectory, getPageWorldProviderScriptPath(false)), 'utf8')
	await Promise.all(generatePageWorldProviders(inpageSource).map(async (artifact) => await fs.writeFile(path.join(appDirectory, artifact.path), artifact.source)))
}

if (import.meta.main) {
	writePageWorldProviders().catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
}

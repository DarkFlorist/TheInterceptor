import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const documentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start.js')
const inpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage.js')
const injectedMarkerPattern = /injectScript\((['"])\[\[injected\.ts\]\]\1\)/

export function inlineInpageSourceIntoDocumentStart(documentStartSource: string, inpageSource: string) {
	if (!injectedMarkerPattern.test(documentStartSource)) throw new Error('Could not find inpage injection marker in document_start.js')
	return documentStartSource.replace(injectedMarkerPattern, `injectScript(${ JSON.stringify(inpageSource) })`)
}

async function inlineInpageScript() {
	const [documentStartSource, inpageSource] = await Promise.all([
		fs.readFile(documentStartPath, 'utf8'),
		fs.readFile(inpagePath, 'utf8'),
	])
	const updatedDocumentStartSource = inlineInpageSourceIntoDocumentStart(documentStartSource, inpageSource)
	await fs.writeFile(documentStartPath, updatedDocumentStartSource)
}

if (import.meta.main) {
	inlineInpageScript().catch((error: unknown) => {
		console.error(error)
		process.exit(1)
	})
}

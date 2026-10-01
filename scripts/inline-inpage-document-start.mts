import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'

const projectRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const documentStartPath = path.join(projectRoot, 'app', 'inpage', 'js', 'document_start.js')
const inpagePath = path.join(projectRoot, 'app', 'inpage', 'js', 'inpage.js')
const injectedMarkerPattern = /injectScript\((['"])\[\[injected\.ts\]\]\1\)/

export async function getClassicInpageSource(inpagePath: string) {
	// MV2 embeds this provider as a classic script, so resolve its shared protocol imports before embedding.
	const build = await Bun.build({ entrypoints: [inpagePath], target: 'browser', format: 'iife' })
	if (!build.success) throw new Error(`Failed to bundle the document-start provider: ${ build.logs.map((log) => log.message).join('\n') }`)
	const output = build.outputs[0]
	if (output === undefined) throw new Error('Missing document-start provider bundle.')
	const source = await output.text()
	Function(source)
	return source
}

async function inlineInpageScript() {
	const [documentStartSource, inpageSource] = await Promise.all([
		fs.readFile(documentStartPath, 'utf8'),
		getClassicInpageSource(inpagePath),
	])
	if (!injectedMarkerPattern.test(documentStartSource)) throw new Error('Could not find inpage injection marker in document_start.js')
	await fs.writeFile(inpagePath, inpageSource)
	const updatedDocumentStartSource = documentStartSource.replace(injectedMarkerPattern, `injectScript(${ JSON.stringify(inpageSource) })`)
	await fs.writeFile(documentStartPath, updatedDocumentStartSource)
}

if (import.meta.main) inlineInpageScript().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})

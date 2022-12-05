import * as path from 'path'
import * as url from 'url'
import { promises as fs } from 'fs'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))

const injection = '../js/inpage.js'
const fileToInject = 'document_start.ts'
const fieldToReplace = '[[injected.ts]]'

const outputFolder = path.join(directoryOfThisFile, '../build/')
const output = `${outputFolder}injected_document_start.ts`

function replaceAll(source: string, search: string, replacement: string) {
    return source.replace(new RegExp(search, 'g'), replacement);
}

// replaces the value `fieldToReplace` with `injection` in `fileToInject` and copies the file to `output`. While escaping the contents
async function injectJsString() {
	const contents = await fs.readFile(path.join(directoryOfThisFile, injection), 'utf8')
	const escaped = replaceAll(replaceAll(contents,'`', '\\`'), '\\$', '\\$')
	const fileToInjectContents = await fs.readFile(path.join(directoryOfThisFile, fileToInject), 'utf8')
	const newFile = fileToInjectContents.replace(fieldToReplace, escaped)

	await fs.mkdir(outputFolder, { recursive: true })
	await fs.writeFile(output, newFile)
}

injectJsString().catch(error => {
	console.error(error)
	debugger
	process.exit(1)
})

import { runIfRoot, run } from './micro-should.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

function *walkSync(dir: string) : Generator<string> {
	const files = fs.readdirSync(dir, { withFileTypes: true })
	for (const file of files) {
		if (file.isDirectory()) {
			yield* walkSync(path.join(dir, file.name))
		} else {
			yield path.join(dir, file.name)
		}
	}
}

const __filename = fileURLToPath(import.meta.url)
const TEST_DIRECTORY = path.join(path.dirname(__filename), 'tests')

async function importValidateAndRun(relativeFilePath: string) {
	const imported = await import(relativeFilePath)
	if (!('main' in imported)) return
	await imported.main()
}

await runIfRoot(async () => {
	const filesToRun = process.argv.slice(2)
	if ( filesToRun.length > 0) { // run only specified ones
		for (const relativeFilePath of filesToRun) {
			await importValidateAndRun(relativeFilePath)
		}
	} else { // run all files
		for (const file of walkSync(TEST_DIRECTORY)) {
			if ( path.extname(file) !== '.js') continue
			const relativeFilePath = `./${ path.relative(path.dirname(__filename), file) }`
			await importValidateAndRun(relativeFilePath)
		}
	}
	await run()
}, import.meta)

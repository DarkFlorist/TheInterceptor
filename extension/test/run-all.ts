import { runIfRoot, run } from './micro-should.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

function *walkSync(dir: string) : Generator<string> {
	const files = fs.readdirSync(dir, { withFileTypes: true });
	for (const file of files) {
		if (file.isDirectory()) {
			yield* walkSync(path.join(dir, file.name));
		} else {
			yield path.join(dir, file.name);
		}
	}
}

const __filename = fileURLToPath(import.meta.url);
const TEST_DIRECTORY = path.join(path.dirname(__filename), 'tests')

await runIfRoot(async () => {
	for (const file of walkSync(TEST_DIRECTORY)) {
		const relativeFilePath = `./${ path.relative(path.dirname(__filename), file) }`
		const imported = await import(relativeFilePath)
		if( ! ('main' in imported) && typeof imported.main === 'function') throw new Error(`missing main function in ${ relativeFilePath }`)

		await imported.main()
	}
	await run()
}, import.meta)

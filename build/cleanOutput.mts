import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'

const repositoryRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const relativePaths = process.argv.slice(2)

if (relativePaths.length === 0) {
	throw new Error('At least one path is required.')
}

for (const relativePath of relativePaths) {
	const absolutePath = path.resolve(repositoryRoot, relativePath)
	const isInsideRepository = absolutePath === repositoryRoot || absolutePath.startsWith(`${ repositoryRoot }${ path.sep }`)
	if (!isInsideRepository) {
		throw new Error(`Refusing to remove path outside repository: ${ relativePath }`)
	}
	fs.rmSync(absolutePath, { recursive: true, force: true })
}

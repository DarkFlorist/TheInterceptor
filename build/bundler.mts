import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const nodeModulesDirectory = path.join(directoryOfThisFile, '..', 'node_modules')
const vendorDirectory = path.join(directoryOfThisFile, '..', 'app', 'vendor')
const browserResolvedImports = {
	'@noble/hashes/crypto': path.join(nodeModulesDirectory, '@noble', 'hashes', 'esm', 'crypto.js'),
} as const

function getRelativePath(from: string, to: string) {
	let relativePath = path.relative(from, to)
	if (relativePath === '' || (!relativePath.startsWith('../') && !relativePath.startsWith('/'))) {
		relativePath = `./${ relativePath || '.' }`
	}
	return relativePath
}

const toFileSystemPath = (value: string) => value.startsWith('file://') ? url.fileURLToPath(value) : value
const isBareSpecifier = (specifier: string) => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('data:') && !specifier.startsWith('file:')

const getResolverBasePath = (filePath: string) => filePath.startsWith(`${ vendorDirectory }${ path.sep }`)
	? path.join(nodeModulesDirectory, path.relative(vendorDirectory, filePath))
	: filePath

const getVendoredImportPath = (filePath: string, specifier: string) => {
	if (!isBareSpecifier(specifier)) return undefined
	try {
		const basePath = getResolverBasePath(filePath)
		const resolvedPath = browserResolvedImports[specifier as keyof typeof browserResolvedImports] ?? toFileSystemPath(import.meta.resolveSync(specifier, url.pathToFileURL(basePath).href))
		const relativeNodeModulesPath = path.relative(nodeModulesDirectory, resolvedPath)
		if (relativeNodeModulesPath.startsWith('..')) return undefined
		const newLocation = path.join(vendorDirectory, relativeNodeModulesPath)
		return getRelativePath(path.dirname(filePath), newLocation).replace(/\\/g, '/')
	} catch {
		return undefined
	}
}

const replaceQuotedModuleSpecifier = (filePath: string, specifier: string) => {
	const vendoredImportPath = getVendoredImportPath(filePath, specifier)
	return vendoredImportPath === undefined ? `'${ specifier }'` : `'${ vendoredImportPath }'`
}

export function replaceImport(filePath: string, text: string) {
	let replaced = text.replace(/((?:import|export)\s+(?:[^'";]+?\s+from\s+)?)['"]([^'"]+)['"]/g, (full, prefix: string, specifier: string) => `${ prefix }${ replaceQuotedModuleSpecifier(filePath, specifier) }`)
	replaced = replaced.replace(/(import\s*\(\s*)['"]([^'"]+)['"](\s*\))/g, (full, prefix: string, specifier: string, suffix: string) => `${ prefix }${ replaceQuotedModuleSpecifier(filePath, specifier) }${ suffix }`)
	replaced = replaced.replace(/require\(\s*['"]([^'"]+)['"]\s*\)/g, (full, specifier: string) => `require(${ replaceQuotedModuleSpecifier(filePath, specifier) })`)
	return replaced
}

async function* getFiles(topDir: string): AsyncGenerator<string, void, undefined> {
	const dirContents = await fs.readdir(topDir, { withFileTypes: true })
	for (const dir of dirContents) {
		const res = path.resolve(topDir, dir.name);
		if (dir.isDirectory()) {
			yield* getFiles(res)
		} else {
			yield res
		}
	}
}

async function ensureDirectoryExists(dir: string) {
	try {
		await fs.access(dir)
	} catch {
		await fs.mkdir(dir)
	}
}

async function replaceImportsInJSFiles() {
	const folders = [
		path.join(directoryOfThisFile, '..', 'app', 'js'),
		path.join(directoryOfThisFile, '..', 'app', 'vendor')
	]
	for (const folder of folders) {
		await ensureDirectoryExists(folder)
		for await (const filePath of getFiles(folder)) {
			if (path.extname(filePath) !== '.js' && path.extname(filePath) !== '.mjs') continue
			const replaced = replaceImport(filePath, await fs.readFile(filePath, 'utf8'))
			await fs.writeFile(filePath, replaced)
		}
	}
}

replaceImportsInJSFiles().catch(error => {
	console.error(error)
	process.exit(1)
})

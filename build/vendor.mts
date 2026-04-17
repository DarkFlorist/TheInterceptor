import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { type FileType, recursiveDirectoryCopy } from '@zoltu/file-copier'
import { createHash } from 'node:crypto'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))

const dependencyPaths = [
	{ packageName: 'ethers', subfolderToVendor: 'dist', entrypointFile: 'ethers.js' },
	{ packageName: 'webextension-polyfill', subfolderToVendor: 'dist', entrypointFile: 'browser-polyfill.js' },
	{ packageName: 'preact', subfolderToVendor: 'dist', entrypointFile: 'preact.module.js' },
	{ packageName: 'preact/jsx-runtime', subfolderToVendor: 'dist', entrypointFile: 'jsxRuntime.module.js' },
	{ packageName: 'preact/hooks', subfolderToVendor: 'dist', entrypointFile: 'hooks.module.js' },
	{ packageName: 'preact/compat', subfolderToVendor: 'dist', entrypointFile: 'compat.module.js' },
	{ packageName: '@preact/signals', subfolderToVendor: 'dist', entrypointFile: 'signals.module.js' },
	{ packageName: '@preact/signals-core', subfolderToVendor: 'dist', entrypointFile: 'signals-core.module.js', },
	{ packageName: 'funtypes', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
	{ packageName: '@noble/hashes/sha3', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha3.js' },
	{ packageName: '@noble/hashes/sha256', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha256.js' },
	{ packageName: '@noble/hashes/sha512', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha512.js' },
	{ packageName: '@noble/hashes/blake2s', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'blake2s.js' },
	{ packageName: '@noble/hashes/utils', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'utils.js' },
	{ packageName: '@noble/hashes/hmac', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'hmac.js' },
	{ packageName: '@noble/hashes/crypto', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'crypto.js' },
	{ packageName: '@noble/curves/stark', packageToVendor: '@noble/curves', subfolderToVendor: '', entrypointFile: 'stark.js' },
	{ packageName: '@darkflorist/address-metadata', subfolderToVendor: 'lib', entrypointFile: 'index.js' },
]

const codeFileExtensions = ['.js', '.ts', '.mjs', '.mts'] as const
const sourceMapFileExtensions = ['.map'] as const
const declarationFileSuffixes = ['.d.ts', '.d.mts', '.d.cts'] as const
const nodeBuiltinImportPatterns = [
	/(?:^|\n)\s*(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)(['"])node:[^'"]+\1/m,
	/(?:^|\n)\s*import\s+(['"])node:[^'"]+\1/m,
	/\bimport\s*\(\s*(['"])node:[^'"]+\1\s*\)/m,
	/\brequire\s*\(\s*(['"])node:[^'"]+\1\s*\)/m,
]

function hasExtension(filePath: string, extensions: readonly string[]) {
	return extensions.some((extension) => filePath.endsWith(extension))
}

function isGitPath(filePath: string) {
	return filePath.endsWith('.git') || filePath.endsWith('.git/') || filePath.endsWith('.git\\')
}

function isNodeModulesPath(filePath: string) {
	return filePath.endsWith('node_modules') || filePath.endsWith('node_modules/') || filePath.endsWith('node_modules\\')
}

function isAddressMetadataImagePath(filePath: string) {
	return filePath.includes('address-metadata/lib/images') || filePath.includes('address-metadata\\lib\\images')
}

function stripFileSuffix(filePath: string, suffixes: readonly string[]) {
	for (const suffix of suffixes) {
		if (filePath.endsWith(suffix)) return filePath.slice(0, -suffix.length)
	}
	return undefined
}

function getAssociatedCodeFiles(filePath: string) {
	if (hasExtension(filePath, codeFileExtensions)) return [filePath]

	const sourceMapBasePath = stripFileSuffix(filePath, sourceMapFileExtensions)
	if (sourceMapBasePath !== undefined) return getAssociatedCodeFiles(sourceMapBasePath)

	const declarationBasePath = stripFileSuffix(filePath, declarationFileSuffixes)
	if (declarationBasePath !== undefined) {
		return codeFileExtensions
			.map((extension) => `${ declarationBasePath }${ extension }`)
			.filter((candidatePath) => candidatePath !== filePath)
	}

	return []
}

async function fileImportsNodeBuiltin(filePath: string) {
	try {
		const fileContents = await fs.readFile(filePath, 'utf8')
		return nodeBuiltinImportPatterns.some((pattern) => pattern.test(fileContents))
	} catch {
		return false
	}
}

async function shouldIncludeVendoredFile(filePath: string, fileType: FileType) {
	if (isGitPath(filePath) || isNodeModulesPath(filePath)) return false
	if (isAddressMetadataImagePath(filePath)) return true
	if (fileType === 'directory') return true
	if (!hasExtension(filePath, [...codeFileExtensions, ...sourceMapFileExtensions, ...declarationFileSuffixes])) return false

	const associatedCodeFiles = getAssociatedCodeFiles(filePath)
	for (const associatedCodeFile of associatedCodeFiles) {
		if (await fileImportsNodeBuiltin(associatedCodeFile)) return false
	}
	return true
}

async function vendorDependencies(files: string[]) {
	for (const { packageName, packageToVendor, subfolderToVendor } of dependencyPaths) {
		const sourceDirectoryPath = path.join(directoryOfThisFile, '..', 'node_modules', packageToVendor || packageName, subfolderToVendor)
		const destinationDirectoryPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', packageToVendor || packageName)
		await fs.rm(destinationDirectoryPath, { recursive: true, force: true })
		await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath, shouldIncludeVendoredFile, rewriteSourceMapSourcePath.bind(undefined, packageName))
	}

	const importmap = dependencyPaths.reduce((importmap, { packageName, entrypointFile, packageToVendor }) => {
		importmap.imports[packageName] = `../${path.join('.', 'vendor', packageToVendor || packageName, entrypointFile).replace(/\\/g, '/') }`
		return importmap
	}, { imports: {} as Record<string, string> })
	const importmapJson = `\n${JSON.stringify(importmap, undefined, '\t')
		.replace(/^/mg, '\t\t')}\n\t\t`

	// replace in files
	for ( const file of files ) {
		const indexHtmlPath = path.join(directoryOfThisFile, '..', 'app', file)
		const oldIndexHtml = await fs.readFile(indexHtmlPath, 'utf8')
		const newIndexHtml = oldIndexHtml.replace(/<script type = 'importmap'>[\s\S]*?<\/script>/m, `<script type = 'importmap'>${ importmapJson }</script>`)
		await fs.writeFile(indexHtmlPath, newIndexHtml)
	}

	// update the new hash to manifest.json
	const base64EncodedSHA256 = createHash('sha256').update(importmapJson).digest('base64')
	const manifestLocation = path.join(directoryOfThisFile, '..', 'app', 'manifestV2.json')
	const oldManifest = await fs.readFile(manifestLocation, 'utf8')
	const newManifest = oldManifest.replace(/sha256-[\s\S]*?'/m, `sha256-${ base64EncodedSHA256 }'`)
	await fs.writeFile(manifestLocation, newManifest)
}

// rewrite the source paths in sourcemap files so they show up in the debugger in a reasonable location and if two source maps refer to the same (relative) path, we end up with them distinguished in the browser debugger
async function rewriteSourceMapSourcePath(packageName: string, sourcePath: string, destinationPath: string) {
	const fileExtension = path.extname(sourcePath)
	if (fileExtension !== '.map') return
	const fileContents = JSON.parse(await fs.readFile(sourcePath, 'utf-8')) as { sources: string[] }
	for (let i = 0; i < fileContents.sources.length; ++i) {
		// we want to ensure all source files show up in the appropriate directory and don't leak out of our directory tree, so we strip leading '../' references
		const sourcePath = fileContents.sources[i].replace(/^(?:.\/)*/, '').replace(/^(?:..\/)*/, '')
		fileContents.sources[i] = ['dependencies://dependencies', packageName, sourcePath].join('/')
	}
	await fs.writeFile(destinationPath, JSON.stringify(fileContents))
}

const files = [
	'html/background.html',
	'html/popup.html',
	'html/confirmTransaction.html',
	'html/interceptorAccess.html',
	'html/changeChain.html',
	'html/fetchSimulationStack.html',
	'html/addressBook.html',
	'html/settingsView.html',
	'html/websiteAccess.html'
]

vendorDependencies(files).catch(error => {
	console.error(error)
	debugger
	process.exit(1)
})

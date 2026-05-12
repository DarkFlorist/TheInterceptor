import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { type FileType, recursiveDirectoryCopy } from '@zoltu/file-copier'
import { createHash } from 'node:crypto'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const nodeModulesDirectory = path.join(directoryOfThisFile, '..', 'node_modules')
const browserResolvedImports = {
	'@noble/hashes/crypto': path.join(nodeModulesDirectory, '@noble', 'hashes', 'esm', 'crypto.js'),
} as const

const importMapDependencies = [
	'webextension-polyfill',
	'preact',
	'preact/jsx-runtime',
	'preact/hooks',
	'preact/compat',
	'@preact/signals',
	'@preact/signals-core',
	'funtypes',
	'@noble/hashes/sha3',
	'@noble/hashes/sha256',
	'@noble/hashes/sha512',
	'@noble/hashes/blake2s',
	'@noble/hashes/utils',
	'@noble/hashes/hmac',
	'@noble/hashes/crypto',
	'@noble/curves/stark',
	'@darkflorist/address-metadata',
	'viem/utils',
	'viem/ens',
	'viem/accounts',
] as const

const extraPackageRoots = [
	'ox',
	'abitype',
	'@scure/base',
	'@scure/bip32',
	'@scure/bip39',
	'eventemitter3',
	'@noble/ciphers',
] as const

const getPackageRoot = (packageName: string) => packageName.startsWith('@') ? packageName.split('/').slice(0, 2).join('/') : packageName.split('/')[0]!
const toFileSystemPath = (value: string) => value.startsWith('file://') ? url.fileURLToPath(value) : value

const vendoredPackageRoots = [...new Set([
	...importMapDependencies.map(getPackageRoot),
	...extraPackageRoots,
])]

const getVendoredImportMapLocation = (packageName: string) => {
	const resolvedPath = browserResolvedImports[packageName as keyof typeof browserResolvedImports] ?? toFileSystemPath(import.meta.resolveSync(packageName))
	const relativePath = path.relative(nodeModulesDirectory, resolvedPath)
	if (relativePath.startsWith('..')) throw new Error(`Unable to vendor ${ packageName }: ${ resolvedPath } is outside ${ nodeModulesDirectory }`)
	return `../${ path.join('vendor', relativePath).replace(/\\/g, '/') }`
}

async function vendorDependencies(files: string[]) {
	await fs.rm(path.join(directoryOfThisFile, '..', 'app', 'vendor'), { recursive: true, force: true })
	for (const packageRoot of vendoredPackageRoots) {
		const sourceDirectoryPath = path.join(nodeModulesDirectory, packageRoot)
		const destinationDirectoryPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', packageRoot)
		async function inclusionPredicate(path: string, fileType: FileType) {
			if (/[.](?:spec|test|bench)[.][cm]?[jt]s$/.test(path)) return false
			if (/(?:^|[\\/])(?:test|tests|__tests__|benchmark|benchmarks)(?:[\\/]|$)/.test(path)) return false
			if (path.endsWith('.js')) return true
			if (path.endsWith('.ts')) return true
			if (path.endsWith('.mjs')) return true
			if (path.endsWith('.mts')) return true
			if (path.endsWith('.map')) return true
			if (path.endsWith('.git') || path.endsWith('.git/') || path.endsWith('.git\\')) return false
			if (path.includes('address-metadata/lib/images') || path.includes('address-metadata\\lib\\images')) return true
			if (fileType === 'directory') return true
			return false
		}
		await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath, inclusionPredicate, rewriteSourceMapSourcePath.bind(undefined, packageRoot))
	}

	const importmap = importMapDependencies.reduce((importmap, packageName) => {
		importmap.imports[packageName] = getVendoredImportMapLocation(packageName)
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

import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const repositoryRoot = path.join(directoryOfThisFile, '..')
const nodeModulesDirectory = path.join(directoryOfThisFile, '..', 'node_modules')
const vendorDirectory = path.join(repositoryRoot, 'app', 'vendor')
const temporaryVendorDirectory = path.join(repositoryRoot, 'app', '.vendor-next')
const previousVendorDirectory = path.join(repositoryRoot, 'app', '.vendor-previous')
const vendorCacheStampPath = path.join(vendorDirectory, '.vendor-cache-stamp')
const vendorCacheManifestFileName = '.vendor-cache-manifest'
const vendorCacheManifestPath = path.join(vendorDirectory, vendorCacheManifestFileName)
const vendoredDependencyMirrorDirectoryName = '__dependencies__'
const vendorManifestHashPattern = /^[0-9a-f]{64}$/

const vendoredDependencies = [
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
	'@adraffy/ens-normalize',
	'@scure/base',
	'@scure/bip32',
	'@scure/bip39',
	'eventemitter3',
	'@noble/ciphers',
] as const

const vendorTypeShims = [
	{
		pathParts: ['viem', '_esm', 'utils', 'index.d.ts'],
		contents: 'export * from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'ens', 'index.d.ts'],
		contents: 'export * from \'viem/ens\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'accounts', 'index.d.ts'],
		contents: 'export * from \'viem/accounts\'\n',
	},
	{
		pathParts: ['@noble', 'hashes', 'esm', 'sha3.d.ts'],
		contents: 'export * from \'@noble/hashes/sha3\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'decodeAbiParameters.d.ts'],
		contents: 'export { decodeAbiParameters } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'decodeEventLog.d.ts'],
		contents: 'export { decodeEventLog } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'decodeFunctionData.d.ts'],
		contents: 'export { decodeFunctionData } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'encodeAbiParameters.d.ts'],
		contents: 'export { encodeAbiParameters } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'encodePacked.d.ts'],
		contents: 'export { encodePacked } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'abi', 'formatAbiItem.d.ts'],
		contents: 'export { formatAbiItem } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'address', 'getAddress.d.ts'],
		contents: 'export { getAddress } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'address', 'getContractAddress.d.ts'],
		contents: 'export { getCreate2Address } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'address', 'isAddress.d.ts'],
		contents: 'export { isAddress } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'data', 'concat.d.ts'],
		contents: 'export { concat } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'encoding', 'toHex.d.ts'],
		contents: 'export { bytesToHex } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'encoding', 'toBytes.d.ts'],
		contents: 'export { stringToBytes } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'encoding', 'toRlp.d.ts'],
		contents: 'export { toRlp } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'ens', 'namehash.d.ts'],
		contents: 'export { namehash } from \'viem/ens\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'hash', 'keccak256.d.ts'],
		contents: 'export { keccak256 } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'hash', 'toEventSelector.d.ts'],
		contents: 'export { toEventSelector } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'hash', 'toFunctionSelector.d.ts'],
		contents: 'export { toFunctionSelector } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'signature', 'recoverAddress.d.ts'],
		contents: 'export { recoverAddress } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'signature', 'hashMessage.d.ts'],
		contents: 'export { hashMessage } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'signature', 'hashTypedData.d.ts'],
		contents: 'export { hashStruct, hashTypedData } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'transaction', 'parseTransaction.d.ts'],
		contents: 'export { parseTransaction } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'transaction', 'serializeTransaction.d.ts'],
		contents: 'export { serializeTransaction } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'utils', 'unit', 'formatUnits.d.ts'],
		contents: 'export { formatUnits } from \'viem/utils\'\n',
	},
	{
		pathParts: ['viem', '_esm', 'accounts', 'privateKeyToAccount.d.ts'],
		contents: 'export { privateKeyToAccount } from \'viem/accounts\'\n',
	},
	{
		pathParts: ['abitype', 'dist', 'esm', 'human-readable', 'parseAbiItem.d.ts'],
		contents: 'export { parseAbiItem } from \'abitype\'\n',
	},
	{
		pathParts: ['abitype', 'dist', 'esm', 'human-readable', 'parseAbiParameters.d.ts'],
		contents: 'export { parseAbiParameters } from \'abitype\'\n',
	},
	{
		pathParts: ['@adraffy', 'ens-normalize', 'dist', 'index.d.ts'],
		contents: 'export { ens_normalize } from \'@adraffy/ens-normalize\'\n',
	},
] as const

const getPackageRoot = (packageName: string) => packageName.startsWith('@') ? packageName.split('/').slice(0, 2).join('/') : packageName.split('/')[0]!

const vendoredPackageRoots = [...new Set([
	...vendoredDependencies.map(getPackageRoot),
	...extraPackageRoots,
])]

async function recursiveDirectoryCopy(source: string, destination: string, include?: (path: string, fileType: 'directory' | 'file') => Promise<boolean>, transform?: (sourcePath: string, destinationPath: string) => Promise<void>) {
	const entries = await fs.readdir(source, { withFileTypes: true })
	await fs.mkdir(destination, { recursive: true })
	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name)
		const destinationPath = path.join(destination, entry.name)
		if (entry.isDirectory()) {
			if (include && !await include(sourcePath, 'directory')) continue
			await recursiveDirectoryCopy(sourcePath, destinationPath, include, transform)
		} else {
			if (include && !await include(sourcePath, 'file')) continue
			await fs.copyFile(sourcePath, destinationPath)
		}
		await transform?.(sourcePath, destinationPath)
	}
}

async function vendorDependencies() {
	const vendorCacheKey = await getVendorCacheKey()
	if (await canReuseVendorDirectory(vendorCacheKey)) return

	await fs.rm(temporaryVendorDirectory, { recursive: true, force: true })
	await fs.rm(previousVendorDirectory, { recursive: true, force: true })
	try {
		for (const packageRoot of vendoredPackageRoots) {
			const sourceDirectoryPath = path.join(nodeModulesDirectory, packageRoot)
			const destinationDirectoryPath = path.join(temporaryVendorDirectory, packageRoot)
			async function inclusionPredicate(path: string, fileType: 'directory' | 'file') {
				if (/[.](?:spec|test|bench)[.][cm]?[jt]s$/.test(path)) return false
				if (/(?:^|[\\/])(?:test|tests|__tests__|benchmark|benchmarks)(?:[\\/]|$)/.test(path)) return false
				if (path.endsWith('.js')) return true
				if (path.endsWith('.ts')) return true
				if (path.endsWith('.mjs')) return true
				if (path.endsWith('.mts')) return true
				if (path.endsWith('package.json')) return true
				if (path.endsWith('.map')) return true
				if (path.endsWith('.git') || path.endsWith('.git/') || path.endsWith('.git\\')) return false
				if (path.includes('address-metadata/lib/images') || path.includes('address-metadata\\lib\\images')) return true
				if (fileType === 'directory') return true
				return false
			}
			await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath, inclusionPredicate, rewriteSourceMapSourcePath.bind(undefined, packageRoot))
			await rewriteNestedNodeModulesDirectory(destinationDirectoryPath)
			if (packageRoot === '@darkflorist/address-metadata') await exposeAddressMetadataImagesAtPackageRoot(destinationDirectoryPath)
		}
		await writeVendorTypeShims(temporaryVendorDirectory)
		await fs.writeFile(path.join(temporaryVendorDirectory, path.basename(vendorCacheStampPath)), `${ vendorCacheKey }\n`)
		const vendorFileManifest = await getVendorFileManifest(temporaryVendorDirectory)
		await fs.writeFile(path.join(temporaryVendorDirectory, vendorCacheManifestFileName), `${ vendorFileManifest.map(formatVendorManifestEntry).join('\n') }\n`)
		await replaceVendorDirectory()
	} catch (error) {
		await fs.rm(temporaryVendorDirectory, { recursive: true, force: true })
		throw error
	}
}

async function replaceVendorDirectory() {
	const hadPreviousVendor = await pathExists(vendorDirectory)
	let movedPreviousVendor = false
	let installedNewVendor = false
	try {
		if (hadPreviousVendor) {
			await fs.rename(vendorDirectory, previousVendorDirectory)
			movedPreviousVendor = true
		}
		await fs.rename(temporaryVendorDirectory, vendorDirectory)
		installedNewVendor = true
	} catch (error) {
		if (installedNewVendor) await fs.rm(vendorDirectory, { recursive: true, force: true })
		if (movedPreviousVendor && await pathExists(previousVendorDirectory)) {
			await fs.rename(previousVendorDirectory, vendorDirectory)
		}
		throw error
	}
	if (!movedPreviousVendor) return
	try {
		await fs.rm(previousVendorDirectory, { recursive: true, force: true })
	} catch (error) {
		console.warn(`Failed to remove previous vendor directory: ${ previousVendorDirectory }`, error)
	}
}

async function pathExists(pathToCheck: string) {
	try {
		await fs.access(pathToCheck)
		return true
	} catch {
		return false
	}
}

async function getVendorCacheKey() {
	const hash = createHash('sha256')
	hash.update('vendor-cache-v1\n')
	hash.update(JSON.stringify(vendoredPackageRoots))
	hash.update('\n')
	hash.update(JSON.stringify(vendorTypeShims))
	hash.update('\n')
	const cacheInputPaths = [
		path.join(repositoryRoot, 'package.json'),
		path.join(repositoryRoot, 'bun.lock'),
		path.join(directoryOfThisFile, 'package.json'),
		path.join(directoryOfThisFile, 'bun.lock'),
		path.join(directoryOfThisFile, 'bundler.mts'),
		url.fileURLToPath(import.meta.url),
		...vendoredPackageRoots.map((packageRoot) => path.join(nodeModulesDirectory, packageRoot, 'package.json')),
	]
	for (const cacheInputPath of cacheInputPaths) {
		hash.update(cacheInputPath)
		hash.update('\n')
		try {
			hash.update(await fs.readFile(cacheInputPath))
		} catch {
			hash.update('missing')
		}
		hash.update('\n')
	}
	return hash.digest('hex')
}

async function canReuseVendorDirectory(vendorCacheKey: string) {
	try {
		const cachedVendorKey = (await fs.readFile(vendorCacheStampPath, 'utf8')).trim()
		if (cachedVendorKey !== vendorCacheKey) return false
		const vendorFileManifest = getCachedVendorFileManifest(await fs.readFile(vendorCacheManifestPath, 'utf8'))
		if (vendorFileManifest === undefined) return false
		for (const vendorFile of vendorFileManifest) {
			const currentFileHash = await getFileHash(path.join(vendorDirectory, vendorFile.relativePath))
			if (currentFileHash !== vendorFile.hash) return false
		}
		return true
	} catch {
		return false
	}
}

function getCachedVendorFileManifest(vendorFileManifestContents: string) {
	const vendorFileManifestLines = vendorFileManifestContents
		.split('\n')
		.map((vendorManifestEntry) => vendorManifestEntry.replace(/\r$/, ''))
		.filter((vendorManifestEntry) => vendorManifestEntry !== '')
	const vendorFileManifest: VendorManifestEntry[] = []
	for (const vendorManifestEntry of vendorFileManifestLines) {
		const parsedVendorManifestEntry = parseVendorManifestEntry(vendorManifestEntry)
		if (parsedVendorManifestEntry === undefined) return undefined
		vendorFileManifest.push(parsedVendorManifestEntry)
	}
	if (vendorFileManifest.length === 0) return undefined
	return vendorFileManifest
}

const isSafeRelativeVendorPath = (relativeVendorPath: string) => !path.isAbsolute(relativeVendorPath) && !relativeVendorPath.split(/[\\/]/).includes('..')

type VendorManifestEntry = {
	hash: string
	relativePath: string
}

function parseVendorManifestEntry(vendorManifestEntry: string): VendorManifestEntry | undefined {
	const separatorIndex = vendorManifestEntry.indexOf('\t')
	if (separatorIndex === -1) return undefined
	const hash = vendorManifestEntry.slice(0, separatorIndex)
	const relativePath = vendorManifestEntry.slice(separatorIndex + 1)
	if (!vendorManifestHashPattern.test(hash)) return undefined
	if (!isSafeRelativeVendorPath(relativePath)) return undefined
	return { hash, relativePath }
}

const formatVendorManifestEntry = (vendorManifestEntry: VendorManifestEntry) => `${ vendorManifestEntry.hash }\t${ vendorManifestEntry.relativePath }`

async function getFileHash(filePath: string) {
	return createHash('sha256')
		.update(await fs.readFile(filePath))
		.digest('hex')
}

async function getVendorFileManifest(vendorRootDirectory: string) {
	const vendorManifestEntries: VendorManifestEntry[] = []
	async function addFiles(directoryPath: string) {
		const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true })
		for (const directoryEntry of directoryEntries) {
			const entryPath = path.join(directoryPath, directoryEntry.name)
			if (directoryEntry.isDirectory()) {
				await addFiles(entryPath)
				continue
			}
			const relativePath = path.relative(vendorRootDirectory, entryPath).replace(/\\/g, '/')
			if (relativePath === vendorCacheManifestFileName) continue
			vendorManifestEntries.push({
				hash: await getFileHash(entryPath),
				relativePath,
			})
		}
	}
	await addFiles(vendorRootDirectory)
	return vendorManifestEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function exposeAddressMetadataImagesAtPackageRoot(packageDirectoryPath: string) {
	const sourceDirectoryPath = path.join(packageDirectoryPath, 'lib', 'images')
	const destinationDirectoryPath = path.join(packageDirectoryPath, 'images')
	const sourceStats = await fs.stat(sourceDirectoryPath)
	if (!sourceStats.isDirectory()) return
	await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath)
}

async function rewriteNestedNodeModulesDirectory(packageDirectoryPath: string) {
	const nestedNodeModulesDirectoryPath = path.join(packageDirectoryPath, 'node_modules')
	const nestedDependenciesDirectoryPath = path.join(packageDirectoryPath, vendoredDependencyMirrorDirectoryName)
	try {
		const nestedNodeModulesStats = await fs.stat(nestedNodeModulesDirectoryPath)
		if (!nestedNodeModulesStats.isDirectory()) return
	} catch {
		return
	}
	await fs.rm(nestedDependenciesDirectoryPath, { recursive: true, force: true })
	await fs.rename(nestedNodeModulesDirectoryPath, nestedDependenciesDirectoryPath)
}

async function writeVendorTypeShims(destinationRootDirectory: string) {
	for (const shim of vendorTypeShims) {
		const destinationPath = path.join(destinationRootDirectory, ...shim.pathParts)
		await fs.mkdir(path.dirname(destinationPath), { recursive: true })
		await fs.writeFile(destinationPath, shim.contents)
	}
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

vendorDependencies().catch(error => {
	console.error(error)
	process.exit(1)
})

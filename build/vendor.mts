import * as path from 'node:path'
import * as url from 'node:url'
import { promises as fs } from 'node:fs'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const nodeModulesDirectory = path.join(directoryOfThisFile, '..', 'node_modules')
const vendoredDependencyMirrorDirectoryName = '__dependencies__'

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

async function recursiveDirectoryCopy(source: string, destination: string, include: (path: string, fileType: 'directory' | 'file') => Promise<boolean>, transform: (sourcePath: string, destinationPath: string) => Promise<void>) {
	const entries = await fs.readdir(source, { withFileTypes: true })
	await fs.mkdir(destination, { recursive: true })
	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name)
		const destinationPath = path.join(destination, entry.name)
		if (entry.isDirectory()) {
			if (!await include(sourcePath, 'directory')) continue
			await recursiveDirectoryCopy(sourcePath, destinationPath, include, transform)
		} else {
			if (!await include(sourcePath, 'file')) continue
			await fs.copyFile(sourcePath, destinationPath)
		}
		await transform(sourcePath, destinationPath)
	}
}

async function vendorDependencies() {
	await fs.rm(path.join(directoryOfThisFile, '..', 'app', 'vendor'), { recursive: true, force: true })
	for (const packageRoot of vendoredPackageRoots) {
		const sourceDirectoryPath = path.join(nodeModulesDirectory, packageRoot)
		const destinationDirectoryPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', packageRoot)
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
	await writeVendorTypeShims()
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

async function writeVendorTypeShims() {
	for (const shim of vendorTypeShims) {
		const destinationPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', ...shim.pathParts)
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

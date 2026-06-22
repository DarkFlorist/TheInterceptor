import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const prunableVendorDirectoryNames = new Set([
	'__tests__',
	'benchmark',
	'benchmarks',
	'src',
	'test',
	'tests',
])

const toPortablePath = (filePath: string) => filePath.split(path.sep).join('/')

function isVendorPath(relativePath: string) {
	return relativePath === 'vendor' || relativePath.startsWith('vendor/')
}

function hasPrunableVendorDirectory(relativePath: string) {
	if (!isVendorPath(relativePath)) return false
	return relativePath.split('/').some((part) => prunableVendorDirectoryNames.has(part))
}

export function shouldPruneExtensionPackageDirectory(relativePath: string): boolean {
	const portablePath = toPortablePath(relativePath)
	if (portablePath === 'ts') return true
	if (portablePath === 'inpage/ts') return true
	if (portablePath === 'vendor/@darkflorist/address-metadata/lib/images') return true
	return hasPrunableVendorDirectory(portablePath)
}

export function shouldPruneExtensionPackageFile(relativePath: string): boolean {
	const portablePath = toPortablePath(relativePath)
	const baseName = path.basename(portablePath)
	if (portablePath === 'manifestV2.json' || portablePath === 'manifestV3.json') return true
	if (isVendorPath(portablePath) && baseName === 'package.json') return true
	if (portablePath.endsWith('.d.ts')) return true
	if (portablePath.endsWith('.d.ts.map')) return true
	if (portablePath.endsWith('.map')) return true
	if (/[.][cm]?tsx?$/.test(portablePath)) return true
	return false
}

async function pruneExtensionPackageDirectory(packageDirectory: string, currentDirectory: string) {
	const entries = await fs.readdir(currentDirectory, { withFileTypes: true })
	for (const entry of entries) {
		const entryPath = path.join(currentDirectory, entry.name)
		const relativePath = path.relative(packageDirectory, entryPath)
		if (entry.isDirectory()) {
			if (shouldPruneExtensionPackageDirectory(relativePath)) {
				await fs.rm(entryPath, { recursive: true, force: true })
				continue
			}
			await pruneExtensionPackageDirectory(packageDirectory, entryPath)
			continue
		}
		if (entry.isFile() && shouldPruneExtensionPackageFile(relativePath)) {
			await fs.rm(entryPath, { force: true })
		}
	}
}

export async function prepareExtensionPackage(sourceAppDirectory: string, destinationAppDirectory: string) {
	await fs.rm(destinationAppDirectory, { recursive: true, force: true })
	await fs.cp(sourceAppDirectory, destinationAppDirectory, { recursive: true })
	await pruneExtensionPackageDirectory(destinationAppDirectory, destinationAppDirectory)
}

if (import.meta.main) {
	const [sourceAppDirectory, destinationAppDirectory] = process.argv.slice(2)
	if (sourceAppDirectory === undefined || destinationAppDirectory === undefined) {
		console.error('Usage: bun ./build/pruneExtensionPackage.mts <source-app-directory> <destination-app-directory>')
		process.exit(1)
	}
	await prepareExtensionPackage(sourceAppDirectory, destinationAppDirectory)
}

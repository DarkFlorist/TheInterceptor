import * as path from 'path'
import * as url from 'url'
import { promises as fs } from 'fs'
import { recursiveDirectoryCopy } from '@zoltu/file-copier'
import { createHash } from 'node:crypto'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))

const dependencyPaths = [
	{ packageName: 'ethers', subfolderToVendor: 'dist', entrypointFile: 'ethers.esm.js' },
	{ packageName: 'webextension-polyfill', subfolderToVendor: 'dist', entrypointFile: 'browser-polyfill.js' },
	{ packageName: 'preact', subfolderToVendor: 'dist', entrypointFile: 'preact.module.js' },
	{ packageName: 'preact/jsx-runtime', subfolderToVendor: 'dist', entrypointFile: 'jsxRuntime.module.js' },
	{ packageName: 'preact/hooks', subfolderToVendor: 'dist', entrypointFile: 'hooks.module.js' },
	{ packageName: 'funtypes', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
	{ packageName: 'node-fetch', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
	{ packageName: '@zoltu/ethereum-abi-encoder', subfolderToVendor: 'output-esm', entrypointFile: 'index.js' },
	{ packageName: '@zoltu/ethereum-crypto', subfolderToVendor: 'output-esm', entrypointFile: 'index.js' },
	{ packageName: '@zoltu/rlp-encoder', subfolderToVendor: 'output-esm', entrypointFile: 'index.js' },
	{ packageName: '@darkflorist/address-metadata', subfolderToVendor: 'lib', entrypointFile: 'index.js' },
]

async function vendorDependencies(files: string[]) {
	for (const { packageName, subfolderToVendor } of dependencyPaths) {
		const sourceDirectoryPath = path.join(directoryOfThisFile, '..', 'node_modules', packageName, subfolderToVendor)
		const destinationDirectoryPath = path.join(directoryOfThisFile, '..', 'app', 'vendor', packageName)
		await recursiveDirectoryCopy(sourceDirectoryPath, destinationDirectoryPath, undefined, rewriteSourceMapSourcePath.bind(undefined, packageName))
	}

	const importmap = dependencyPaths.reduce((importmap, { packageName, entrypointFile }) => {
		importmap.imports[packageName] = `../${path.join('.', 'vendor', packageName, entrypointFile).replace(/\\/g, '/') }`
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
	const manifestLocation = path.join(directoryOfThisFile, '..', 'app', 'manifest.json')
	const oldManifest = await fs.readFile(manifestLocation, 'utf8')
	const newManifest = oldManifest.replace(/sha256-[\s\S]*?'/m, `sha256-${ base64EncodedSHA256 }'`)
	await fs.writeFile(manifestLocation, newManifest)
}

// rewrite the source paths in sourcemap files so they show up in the debugger in a reasonable location and if two source maps refer to the same (relative) path, we end up with them distinguished in the browser debugger
async function rewriteSourceMapSourcePath(packageName: string, sourcePath: string, destinationPath: string) {
	const fileExtension = path.extname(sourcePath)
	if (fileExtension !== '.map') return
	const fileContents = JSON.parse(await fs.readFile(sourcePath, 'utf-8')) as { sources: Array<string> }
	for (let i = 0; i < fileContents.sources.length; ++i) {
		// we want to ensure all source files show up in the appropriate directory and don't leak out of our directory tree, so we strip leading '../' references
		const sourcePath = fileContents.sources[i].replace(/^(?:.\/)*/, '').replace(/^(?:..\/)*/, '')
		fileContents.sources[i] = ['dependencies://dependencies', packageName, sourcePath].join('/')
	}
	await fs.writeFile(destinationPath, JSON.stringify(fileContents))
}

const files = ['html/background.html', 'html/popup.html', 'html/confirmTransaction.html', 'html/personalSign.html', 'html/interceptorAccess.html', 'html/changeChain.html']

vendorDependencies(files).catch(error => {
	console.error(error)
	debugger
	process.exit(1)
})

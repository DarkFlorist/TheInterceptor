import * as path from 'path'
import * as url from 'url'
import { promises as fs } from 'fs'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))

const dependencyPaths = [
	{ packageName: 'ethers', subfolderToVendor: 'dist', entrypointFile: 'ethers.js' },
	{ packageName: 'webextension-polyfill', subfolderToVendor: 'dist', entrypointFile: 'browser-polyfill.js' },
	{ packageName: 'preact', subfolderToVendor: 'dist', entrypointFile: 'preact.module.js' },
	{ packageName: 'preact/jsx-runtime', subfolderToVendor: 'dist', entrypointFile: 'jsxRuntime.module.js' },
	{ packageName: 'preact/hooks', subfolderToVendor: 'dist', entrypointFile: 'hooks.module.js' },
	{ packageName: '@preact/signals', subfolderToVendor: 'dist', entrypointFile: 'signals.module.js' },
	{ packageName: '@preact/signals-core', subfolderToVendor: 'dist', entrypointFile: 'signals-core.module.js', },
	{ packageName: 'funtypes', subfolderToVendor: 'lib', entrypointFile: 'index.mjs' },
	{ packageName: '@noble/hashes/crypto', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'cryptoBrowser.js' },
	{ packageName: '@noble/hashes/sha3', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha3.js' },
	{ packageName: '@noble/hashes/sha256', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha256.js' },
	{ packageName: '@noble/hashes/sha512', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'sha512.js' },
	{ packageName: '@noble/hashes/blake2s', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'blake2s.js' },
	{ packageName: '@noble/hashes/utils', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'utils.js' },
	{ packageName: '@noble/hashes/hmac', packageToVendor: '@noble/hashes', subfolderToVendor: 'esm', entrypointFile: 'hmac.js' },
	{ packageName: '@noble/curves/stark', packageToVendor: '@noble/curves', subfolderToVendor: '', entrypointFile: 'stark.js' },
	{ packageName: '@darkflorist/address-metadata', subfolderToVendor: 'lib', entrypointFile: 'index.js' },
]

export function replaceImport(filePath: string, text: string) {
	let replaced = text
	for (const dependency of dependencyPaths) {
		const newLocation = path.join(directoryOfThisFile, '..', 'app', 'vendor', dependency.packageToVendor === undefined ? dependency.packageName : dependency.packageToVendor, dependency.entrypointFile)
		const fileFolder = path.dirname(filePath)

		replaced = replaced.replaceAll(`import '${ dependency.packageName }'`, `import '${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }'`)
		replaced = replaced.replaceAll(` from '${ dependency.packageName }'`, ` from '${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }'`)
		replaced = replaced.replaceAll(` from "${ dependency.packageName }"`, ` from '${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }'`)
		replaced = replaced.replaceAll(`from'${ dependency.packageName }'`, ` from '${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }'`)
		replaced = replaced.replaceAll(`from"${ dependency.packageName }"`, ` from '${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }'`)
		replaced = replaced.replaceAll(`require("${ dependency.packageName }")`, `require('${ path.relative(fileFolder, newLocation).replace(/\\/g, '/') }')`)
	}
	return replaced
}

// biome-ignore lint/suspicious/noExplicitAny: Library requirement
async function* getFiles(topDir: string): AsyncGenerator<string, any, undefined> {
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

async function replaceImportsInJSFiles() {
	const folders = [
		path.join(directoryOfThisFile, '..', 'app', 'js'),
		path.join(directoryOfThisFile, '..', 'app', 'vendor')
	]
	for (const folder of folders) {
		for await (const filePath of getFiles(folder)) {
			if (path.extname(filePath) !== '.js' && path.extname(filePath) !== '.mjs') continue
			const replaced = replaceImport(filePath, await fs.readFile(filePath, 'utf8'))
			await fs.writeFile(filePath, replaced)
		}
	}
}

replaceImportsInJSFiles().catch(error => {
	console.error(error)
	debugger
	process.exit(1)
})

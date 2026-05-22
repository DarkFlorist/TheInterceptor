import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import { findMissingRuntimeImportsInRuntimeFiles, isBrowserIncompatibleRuntimeModule, replaceImport } from '../../build/bundler.mts'

const repositoryRoot = process.cwd()

describe('bundler import rewriting', () => {
	test('rewrites minified vendored esm imports without whitespace separators', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', '@preact', 'signals', 'dist', 'signals.mjs')
		const source = 'import{Component as t,options as i}from"preact";import{useMemo as e}from"preact/hooks";import{Signal as r}from"@preact/signals-core";export{Signal}from"@preact/signals-core";'

		const rewritten = replaceImport(filePath, source)

		assert.equal(
			rewritten,
			'import{Component as t,options as i}from"../../../preact/dist/preact.module.js";import{useMemo as e}from"../../../preact/hooks/dist/hooks.module.js";import{Signal as r}from"../../signals-core/dist/signals-core.module.js";export{Signal}from"../../signals-core/dist/signals-core.module.js";',
		)
	})

	test('rewrites bare side-effect imports in generated app modules', () => {
		const filePath = path.join(repositoryRoot, 'app', 'js', 'background', 'background-startup.js')
		const source = 'import"webextension-polyfill";'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, 'import"../../vendor/webextension-polyfill/dist/browser-polyfill.js";')
	})

	test('rewrites nested vendored package imports using the vendored dependency tree', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'ox', '_esm', 'core', 'Hash.js')
		const source = 'import { keccak_256 as noble_keccak256 } from \'@noble/hashes/sha3\';'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, 'import { keccak_256 as noble_keccak256 } from \'../../__dependencies__/@noble/hashes/esm/sha3.js\';')
	})

	test('rewrites vendored relative node_modules imports away from node_modules paths', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'viem', '_esm', 'utils', 'hash', 'keccak256.js')
		const source = 'import { keccak_256 } from \'../../../node_modules/@noble/hashes/esm/sha3.js\';'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, 'import { keccak_256 } from \'../../../__dependencies__/@noble/hashes/esm/sha3.js\';')
	})

	test('does not rewrite comment examples that are not real imports', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'viem', '_esm', 'utils', 'hash', 'keccak256.js')
		const source = '// import { keccak_256 } from \'@noble/hashes/sha3\';\nexport const ok = true;'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, source)
	})

	test('flags viem barrel entrypoints as browser-incompatible runtime modules', () => {
		assert.equal(
			isBrowserIncompatibleRuntimeModule(path.join(repositoryRoot, 'app', 'vendor', 'viem', '_esm', 'utils', 'index.js')),
			true,
		)
		assert.equal(
			isBrowserIncompatibleRuntimeModule(path.join(repositoryRoot, 'app', 'vendor', 'viem', '_esm', 'utils', 'hash', 'keccak256.js')),
			false,
		)
	})

	test('ignores stale generated modules that are not reachable from runtime entrypoints', () => {
		const appJsDirectoryPath = path.join(repositoryRoot, 'app', 'js')
		const staleFilePath = path.join(repositoryRoot, 'app', 'js', 'stale-build-output.js')
		fs.mkdirSync(appJsDirectoryPath, { recursive: true })
		fs.writeFileSync(staleFilePath, 'import \'../vendor/does-not-exist/index.js\';\n')

		try {
			const missingImports = findMissingRuntimeImportsInRuntimeFiles()
			assert.equal(
				missingImports.some(({ filePath }) => filePath === staleFilePath),
				false,
			)
		} finally {
			fs.rmSync(staleFilePath, { force: true })
		}
	})
})

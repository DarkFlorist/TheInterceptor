import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'
import { findMissingRequiredImportedRuntimeAssets, findMissingRuntimeImportsInRuntimeFiles, replaceImport, shouldKeepRuntimeOutputFile, stripSourceMappingUrlComment } from '../../build/bundler.mts'

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

	test('rewrites deduped vendored package imports through the root vendor tree', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'micro-eth-signer', 'advanced', 'abi.js')
		const source = 'import { coders } from \'micro-packed\';'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, 'import { coders } from \'../../micro-packed/index.js\';')
	})

	test('rewrites vendored relative node_modules imports away from node_modules paths', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'micro-eth-signer', 'advanced', 'abi.js')
		const source = 'import { bytesToHex } from \'../node_modules/@noble/hashes/utils.js\';'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, 'import { bytesToHex } from \'../__dependencies__/@noble/hashes/utils.js\';')
	})

	test('does not rewrite comment examples that are not real imports', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'micro-eth-signer', 'core', 'typed-data.js')
		const source = '// import { keccak_256 } from \'@noble/hashes/sha3\';\nexport const ok = true;'

		const rewritten = replaceImport(filePath, source)

		assert.equal(rewritten, source)
	})

	test('does not rewrite AMD dependency array entries as module imports', () => {
		const filePath = path.join(repositoryRoot, 'app', 'vendor', 'webextension-polyfill', 'dist', 'browser-polyfill.js')
		const source = 'define("webextension-polyfill", ["module"], factory);'

		assert.equal(replaceImport(filePath, source), source)
	})

	test('rewrites dynamic imports and require calls', () => {
		const filePath = path.join(repositoryRoot, 'app', 'js', 'background', 'background-startup.js')
		const source = 'const dynamicModule = import("webextension-polyfill"); const requiredModule = require("webextension-polyfill");'

		assert.equal(
			replaceImport(filePath, source),
			'const dynamicModule = import("../../vendor/webextension-polyfill/dist/browser-polyfill.js"); const requiredModule = require("../../vendor/webextension-polyfill/dist/browser-polyfill.js");',
		)
	})

	test('rewrites escaped static and dynamic import specifiers without corrupting surrounding syntax', () => {
		const filePath = path.join(repositoryRoot, 'app', 'js', 'background', 'background-startup.js')
		const cases = [
			{
				source: 'import"webextension-poly\\u0066ill";',
				expected: 'import"../../vendor/webextension-polyfill/dist/browser-polyfill.js";',
			},
			{
				source: 'const dynamicModule = import("webextension-poly\\u0066ill").then(useModule);',
				expected: 'const dynamicModule = import("../../vendor/webextension-polyfill/dist/browser-polyfill.js").then(useModule);',
			},
		]

		for (const { source, expected } of cases) {
			const rewritten = replaceImport(filePath, source)
			assert.equal(rewritten, expected)
			assert.equal(ts.createSourceFile('runtime.js', rewritten, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS).parseDiagnostics.length, 0)
		}
	})

	test('keeps only reachable runtime modules and required public assets', () => {
		const reachableFilePath = path.join(repositoryRoot, 'app', 'vendor', 'micro-eth-signer', 'index.js')
		const reachableRuntimeFiles = new Set([reachableFilePath])

		assert.equal(shouldKeepRuntimeOutputFile(reachableFilePath, reachableRuntimeFiles), true)
		assert.equal(
			shouldKeepRuntimeOutputFile(path.join(repositoryRoot, 'app', 'vendor', 'webextension-polyfill', 'dist', 'browser-polyfill.js'), reachableRuntimeFiles),
			true,
		)
		assert.equal(
			shouldKeepRuntimeOutputFile(path.join(repositoryRoot, 'app', 'vendor', '@darkflorist', 'address-metadata', 'images', 'tokens', '0xdac17f958d2ee523a2206206994597c13d831ec7.png'), reachableRuntimeFiles),
			true,
		)
		assert.equal(
			shouldKeepRuntimeOutputFile(path.join(repositoryRoot, 'app', 'vendor', 'preact', 'src', 'index.d.ts'), reachableRuntimeFiles),
			false,
		)
		assert.equal(
			shouldKeepRuntimeOutputFile(path.join(repositoryRoot, 'app', 'js', 'components', 'App.js.map'), reachableRuntimeFiles),
			false,
		)
	})

	test('requires the polyfill runtime asset to stay reachable from runtime imports', () => {
		const polyfillPath = path.join(repositoryRoot, 'app', 'vendor', 'webextension-polyfill', 'dist', 'browser-polyfill.js')

		assert.deepEqual(findMissingRequiredImportedRuntimeAssets(new Set()), [polyfillPath])
		assert.deepEqual(findMissingRequiredImportedRuntimeAssets(new Set([polyfillPath])), [])
	})

	test('strips source map comments after pruning maps', () => {
		assert.equal(
			stripSourceMappingUrlComment('export const ok = true;\n//# sourceMappingURL=ok.js.map\n'),
			'export const ok = true;\n',
		)
		assert.equal(
			stripSourceMappingUrlComment('export const ok = true;\n'),
			'export const ok = true;\n',
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

import * as assert from 'assert'
import { test } from 'bun:test'
import * as fs from 'node:fs'

test('wallet SDK dependencies are absent from the manifest, lockfile and source imports', async () => {
	const projectRoot = new URL('../..', import.meta.url).pathname
	const manifest = await Bun.file(`${ projectRoot }/package.json`).json()
	for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) assert.equal(name.startsWith('@safe-global/') || name === '@wagmi/connectors', false, `Unexpected wallet dependency: ${ name }`)
	assert.doesNotMatch(await Bun.file(`${ projectRoot }/bun.lock`).text(), /"(?:@safe-global\/[^"]+|@wagmi\/connectors)"/u)
	const testOnlyImports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](@safe-global\/safe-apps-(?:sdk|provider)|@wagmi\/connectors|viem|ox)(?:\/[^'"]*)?['"]/u
	for (const pattern of ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'app/inpage/ts/**/*.ts', 'build/*.mts', 'test/**/*.ts', 'test/**/*.tsx']) {
		for await (const file of new Bun.Glob(pattern).scan({ cwd: projectRoot, absolute: true })) {
			assert.equal(testOnlyImports.test(await Bun.file(file).text()), false, `Test-only SDK dependency imported by ${ file }`)
		}
	}
})

test('Gnosis Safe background dependencies execute only after the browser polyfill import', async () => {
	const ts = await import('typescript')
	const source = fs.readFileSync('app/ts/background/background-startup.ts', 'utf8')
	// Inspect emitted imports so type-only dependencies cannot change the runtime ordering contract.
	const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText
	const module = ts.createSourceFile('background-startup.js', emitted, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
	const firstImport = module.statements.find(ts.isImportDeclaration)
	assert.ok(firstImport)
	assert.equal(firstImport.importClause, undefined, 'browser initialization must be a side-effect import before any background dependency')
	assert.ok(ts.isStringLiteral(firstImport.moduleSpecifier))
	assert.equal(firstImport.moduleSpecifier.text, 'webextension-polyfill')
})

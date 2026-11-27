import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'bun:test'
import ts from 'typescript'
import { INTERNAL_PROVIDER_METHODS, isInternalProviderMethod } from '../../app/shared/ts/internalProviderMethods.js'

for (const file of ['app/inpage/ts/inpage.ts', 'app/ts/background/background.ts']) test(`${ file } consumes the same internal method policy`, () => {
	const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
	const imports = source.statements.filter(ts.isImportDeclaration)
	const declaration = imports.find((entry) => ts.isStringLiteral(entry.moduleSpecifier) && entry.moduleSpecifier.text === '../../shared/ts/internalProviderMethods.js')
	assert.ok(declaration)
	const bindings = declaration.importClause?.namedBindings
	assert.ok(bindings !== undefined && ts.isNamedImports(bindings))
	assert.ok(bindings.elements.some((element) => (element.propertyName ?? element.name).text === 'isInternalProviderMethod'))
})

test('internal methods are private on both sides of the public wallet boundary', () => {
	for (const method of INTERNAL_PROVIDER_METHODS) assert.equal(isInternalProviderMethod(method), true)
	for (const method of ['eth_accounts', 'eth_requestAccounts', 'eth_sendTransaction', 'wallet_requestPermissions', 'site_rpc_request_extra']) assert.equal(isInternalProviderMethod(method), false)
	assert.equal(isInternalProviderMethod('site_rpc_request'), true)
})

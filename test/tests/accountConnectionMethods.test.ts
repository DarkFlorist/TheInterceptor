import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'bun:test'
import ts from 'typescript'
import { ACCOUNT_CONNECTION_METHODS, isAccountConnectionMethod } from '../../app/shared/ts/accountRequestMethods.js'
import { isAccountConnectionMethod as isBackgroundConnectionMethod, isAccountOnlyMethod } from '../../app/ts/background/accountRequestMethods.js'

test('background account connection admission uses the canonical shared predicate', () => {
	assert.strictEqual(isBackgroundConnectionMethod, isAccountConnectionMethod)
	assert.deepEqual(ACCOUNT_CONNECTION_METHODS, ['eth_requestAccounts', 'wallet_requestPermissions'])
	for (const method of ACCOUNT_CONNECTION_METHODS) {
		assert.equal(isAccountConnectionMethod(method), true)
		assert.equal(isAccountOnlyMethod(method), true)
	}
	for (const method of ['eth_accounts', 'wallet_getPermissions', 'eth_sendTransaction', 'unknown']) assert.equal(isAccountConnectionMethod(method), false)
})

test('the classic provider imports account connection policy instead of maintaining a mirror', () => {
	const source = ts.createSourceFile('inpage.ts', fs.readFileSync('app/inpage/ts/inpage.ts', 'utf8'), ts.ScriptTarget.Latest, true)
	const imports = source.statements.filter(ts.isImportDeclaration)
	const declaration = imports.find((candidate) => ts.isStringLiteral(candidate.moduleSpecifier) && candidate.moduleSpecifier.text === '../../shared/ts/accountRequestMethods.js')
	assert.ok(declaration, 'The provider must import the canonical shared policy')
	const bindings = declaration.importClause?.namedBindings
	assert.ok(bindings !== undefined && ts.isNamedImports(bindings), 'The shared policy import must name its predicates')
	assert.ok(bindings.elements.some((element) => (element.propertyName ?? element.name).text === 'isAccountConnectionMethod'))
})

import * as assert from 'node:assert'
import * as path from 'node:path'
import { test } from 'bun:test'
import ts from 'typescript'
import { FORWARDED_METHODS_SETTLED_BY_BACKGROUND } from '../../app/ts/background/forwardedRequestSettlement.js'

const INPAGE_SOURCE_PATH = path.resolve('app/inpage/ts/inpage.ts')
const INPAGE_LIST_NAME = 'FORWARDED_METHODS_SETTLED_BY_BACKGROUND'

// The inpage provider is a classic script, so it cannot import the background list and keeps its own `new Set([...])` copy. Read that copy from the source instead of evaluating the script.
function findInpageSettledMethods(source: string) {
	const sourceFile = ts.createSourceFile(INPAGE_SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const declarations: ts.VariableDeclaration[] = []
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === INPAGE_LIST_NAME) declarations.push(node)
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	const [declaration, ...otherDeclarations] = declarations
	if (declaration === undefined || otherDeclarations.length > 0) throw new Error(`Expected exactly one ${ INPAGE_LIST_NAME } declaration in inpage.ts, found ${ declarations.length }`)
	const initializer = declaration.initializer
	if (initializer === undefined || !ts.isNewExpression(initializer) || initializer.expression.getText(sourceFile) !== 'Set') throw new Error(`${ INPAGE_LIST_NAME } must be initialized with new Set([...])`)
	const [methodList] = initializer.arguments ?? []
	if (methodList === undefined || !ts.isArrayLiteralExpression(methodList)) throw new Error(`${ INPAGE_LIST_NAME } must be built from an array literal`)
	return methodList.elements.map((element) => {
		if (!ts.isStringLiteral(element)) throw new Error(`${ INPAGE_LIST_NAME } may only contain string literals, found: ${ element.getText(sourceFile) }`)
		return element.text
	})
}

test('the inpage provider and the background settle the same forwarded methods', async () => {
	const inpageSettledMethods = findInpageSettledMethods(await Bun.file(INPAGE_SOURCE_PATH).text())
	assert.equal(new Set(inpageSettledMethods).size, inpageSettledMethods.length, 'the inpage list has duplicate methods')
	assert.ok(inpageSettledMethods.length > 0)
	assert.deepEqual([...inpageSettledMethods].sort(), [...FORWARDED_METHODS_SETTLED_BY_BACKGROUND.keys()].sort())
})

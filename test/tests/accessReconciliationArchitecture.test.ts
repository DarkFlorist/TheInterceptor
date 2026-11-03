import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as ts from 'typescript'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const appSourceDirectory = `${ repositoryRoot }app/ts/`
const backgroundDirectory = `${ appSourceDirectory }background/`
const accessManagementPath = `${ backgroundDirectory }accessManagement.ts`
const appSources: { readonly path: string, readonly source: string }[] = []
for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory })) appSources.push({ path, source: await Bun.file(`${ appSourceDirectory }${ path }`).text() })
const accessManagementSource = appSources.find(({ path }) => path === 'background/accessManagement.ts')?.source ?? ''
const failClosedPrimitives = ['readSettingsForAccessReconciliation', 'revokeAffectedApprovalsBecauseSettingsAreUnreadable', 'getAffectedWebsites'] as const
const isHandlerPath = (path: string) => path === 'background/background.ts' || path === 'background/popupMessageHandlers.ts' || path.startsWith('background/popupMessageHandlers/') || path.startsWith('background/popupMessageHandlerRegistries/')
const handlerPaths = appSources.filter(({ path }) => isHandlerPath(path)).map(({ path }) => `${ appSourceDirectory }${ path }`)

// The fixtures import the real accessManagement module, so their callees resolve to the same symbols as the handlers'.
const fixtureDirectory = `${ repositoryRoot }test/fixtures/accessReconciliation/`
const fixtures = {
	adjacentStatement: `${ fixtureDirectory }adjacentStatement.ts`,
	aliasedImport: `${ fixtureDirectory }aliasedImport.ts`,
	multilineCallback: `${ fixtureDirectory }multilineCallback.ts`,
} as const

function createProgram() {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	return ts.createProgram([...handlerPaths, ...Object.values(fixtures)], { ...options, noEmit: true, rootDir: repositoryRoot })
}

const program = createProgram()
const checker = program.getTypeChecker()
const accessManagementFile = program.getSourceFile(accessManagementPath)
const accessManagementModule = accessManagementFile === undefined ? undefined : checker.getSymbolAtLocation(accessManagementFile)
const accessManagementExports = accessManagementModule === undefined ? [] : checker.getExportsOfModule(accessManagementModule)
const exportedSymbol = (name: string) => {
	const symbol = accessManagementExports.find((candidate) => candidate.name === name)
	if (symbol === undefined) throw new Error(`accessManagement.ts does not export ${ name }`)
	return symbol
}
const reconcileCommand = exportedSymbol('reconcileCommittedAccessChange')
const reconciliationFunctions = [exportedSymbol('updateWebsiteApprovalAccesses'), exportedSymbol('finalizeWebsiteAccessChange')]

// Resolves a callee through import aliases to the declaring symbol, so renamed imports are recognised.
function resolveCallee(call: ts.CallExpression) {
	const symbol = checker.getSymbolAtLocation(call.expression)
	if (symbol === undefined) return undefined
	return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
}

function isInsideReconcileCallback(node: ts.Node) {
	for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
		if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue
		const { parent } = current
		if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === current) && resolveCallee(parent) === reconcileCommand) return true
	}
	return false
}

// Lists `file:line` for every reconciliation call and for those not lexically inside a reconcileCommittedAccessChange callback.
function findReconciliationCalls(fileName: string) {
	const sourceFile = program.getSourceFile(fileName)
	if (sourceFile === undefined) throw new Error(`Missing source file ${ fileName }`)
	const found: string[] = []
	const uncontained: string[] = []
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = resolveCallee(node)
			if (callee !== undefined && reconciliationFunctions.includes(callee)) {
				const location = `${ fileName.replace(repositoryRoot, '') }:${ sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 }`
				found.push(location)
				if (!isInsideReconcileCallback(node)) uncontained.push(location)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return { found, uncontained }
}

test('the fail-closed access reconciliation primitives are private to accessManagement', () => {
	assert.notEqual(accessManagementSource, '')
	for (const primitive of failClosedPrimitives) {
		assert.match(accessManagementSource, new RegExp(`\\n(?:async )?function ${ primitive }\\(`, 'u'), primitive)
		assert.doesNotMatch(accessManagementSource, new RegExp(`export (?:async )?function ${ primitive }\\b`, 'u'), primitive)
		for (const { path, source } of appSources) if (path !== 'background/accessManagement.ts') assert.doesNotMatch(source, new RegExp(`\\b${ primitive }\\b`, 'u'), `${ path } uses ${ primitive }`)
	}
})

test('handlers reconcile committed access changes only inside reconcileCommittedAccessChange callbacks', () => {
	assert.notEqual(handlerPaths.length, 0)
	const calls = handlerPaths.map(findReconciliationCalls)
	// Ten handler-side committed-change sites (the eleventh, persistWebsiteAccessChange, is inside accessManagement); an exact count makes a new or removed site an explicit test update.
	assert.equal(calls.flatMap(({ found }) => found).length, 10)
	assert.deepEqual(calls.flatMap(({ uncontained }) => uncontained), [])
})

test('the containment check rejects adjacent statements and aliased imports and accepts multiline callbacks', () => {
	// The fixtures must compile so the check is exercised on code a handler could really contain.
	for (const fixture of Object.values(fixtures)) {
		const sourceFile = program.getSourceFile(fixture)
		assert.deepEqual(sourceFile === undefined ? ['missing'] : program.getSemanticDiagnostics(sourceFile).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [], fixture)
	}
	assert.equal(findReconciliationCalls(fixtures.adjacentStatement).uncontained.length, 1)
	assert.equal(findReconciliationCalls(fixtures.aliasedImport).uncontained.length, 1)
	const multilineCallback = findReconciliationCalls(fixtures.multilineCallback)
	assert.equal(multilineCallback.found.length, 2)
	assert.deepEqual(multilineCallback.uncontained, [])
})

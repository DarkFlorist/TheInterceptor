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
	writeWithoutReconcile: `${ fixtureDirectory }writeWithoutReconcile.ts`,
	discardedChange: `${ fixtureDirectory }discardedChange.ts`,
	writeThenReconcile: `${ fixtureDirectory }writeThenReconcile.ts`,
	voidedChange: `${ fixtureDirectory }voidedChange.ts`,
	reconcileInUncalledClosure: `${ fixtureDirectory }reconcileInUncalledClosure.ts`,
} as const

function createProgram() {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	return ts.createProgram([...handlerPaths, ...Object.values(fixtures)], { ...options, noEmit: true, rootDir: repositoryRoot })
}

const program = createProgram()
const checker = program.getTypeChecker()
const exportedSymbol = (modulePath: string, name: string) => {
	const sourceFile = program.getSourceFile(modulePath)
	const moduleSymbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile)
	const symbol = (moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)).find((candidate) => candidate.name === name)
	if (symbol === undefined) throw new Error(`${ modulePath } does not export ${ name }`)
	return symbol
}
const reconcileCommand = exportedSymbol(accessManagementPath, 'reconcileCommittedAccessChange')
const reconciliationFunctions = [exportedSymbol(accessManagementPath, 'updateWebsiteApprovalAccesses'), exportedSymbol(accessManagementPath, 'finalizeWebsiteAccessChange')]
const committedAccessChangeType = checker.getDeclaredTypeOfSymbol(exportedSymbol(accessManagementPath, 'CommittedAccessChange'))
// The primitives that write website approvals, address consent or interceptor-disabled state. Settings imports and address-book writes are reconciled by their handlers and covered by the containment check above.
const websiteAccessWriters = [
	exportedSymbol(`${ backgroundDirectory }settings.ts`, 'updateWebsiteAccess'),
	exportedSymbol(`${ backgroundDirectory }websiteAccessUpdating.ts`, 'updateWebsiteAccessAndContentScriptInjectionStrategy'),
	exportedSymbol(accessManagementPath, 'setInterceptorDisabledForWebsite'),
	exportedSymbol(accessManagementPath, 'setAccess'),
]

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

type FunctionLikeWithBody = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

function getEnclosingFunction(node: ts.Node): FunctionLikeWithBody | undefined {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (isFunctionLikeWithBody(current)) return current
	}
	return undefined
}

function returnsCommittedAccessChange(declaration: ts.SignatureDeclaration) {
	const signature = checker.getSignatureFromDeclaration(declaration)
	if (signature === undefined) return false
	const returnType = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))
	// `any` and `never` (for example assertNever) are assignable to everything, so they are not committed changes.
	return returnType !== undefined && (returnType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) === 0 && checker.isTypeAssignableTo(returnType, committedAccessChangeType)
}

const isFunctionLikeWithBody = (node: ts.Node): node is FunctionLikeWithBody => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)

// Visits the nodes of a function's own body: nested functions may never run, so nothing inside them counts for the enclosing function.
function forEachNodeInOwnBody(enclosingFunction: FunctionLikeWithBody, onNode: (node: ts.Node) => void) {
	const visit = (node: ts.Node) => {
		onNode(node)
		if (!isFunctionLikeWithBody(node)) ts.forEachChild(node, visit)
	}
	if (enclosingFunction.body !== undefined) ts.forEachChild(enclosingFunction.body, visit)
}

const isReconcileCommandCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && resolveCallee(node) === reconcileCommand

function callsReconcileAfter(enclosingFunction: FunctionLikeWithBody, position: number) {
	let found = false
	forEachNodeInOwnBody(enclosingFunction, (node) => { if (isReconcileCommandCall(node) && node.getStart() > position) found = true })
	return found
}

// The expression a value is consumed as, skipping `await` and parentheses.
function getConsumedExpression(expression: ts.Expression): ts.Expression {
	const { parent } = expression
	return ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent) ? getConsumedExpression(parent) : expression
}

// A committed change is forwarded when it is returned or passed to reconcileCommittedAccessChange in the same function body.
function isForwardedChange(expression: ts.Expression, enclosingFunction: FunctionLikeWithBody | undefined) {
	const consumed = getConsumedExpression(expression)
	const { parent } = consumed
	if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === consumed)) return getEnclosingFunction(consumed) === enclosingFunction
	return isReconcileCommandCall(parent) && parent.arguments.some((argument) => argument === consumed) && getEnclosingFunction(parent) === enclosingFunction
}

// A returned change is consumed only by forwarding it, either directly or through the const it is assigned to.
function isChangeForwarded(call: ts.CallExpression) {
	const enclosingFunction = getEnclosingFunction(call)
	if (isForwardedChange(call, enclosingFunction)) return true
	const declaration = getConsumedExpression(call).parent
	if (enclosingFunction === undefined || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
	const variable = checker.getSymbolAtLocation(declaration.name)
	let forwarded = false
	forEachNodeInOwnBody(enclosingFunction, (node) => { if (ts.isIdentifier(node) && node !== declaration.name && checker.getSymbolAtLocation(node) === variable && isForwardedChange(node, enclosingFunction)) forwarded = true })
	return forwarded
}

const nameOf = (enclosingFunction: FunctionLikeWithBody) => {
	if (enclosingFunction.name !== undefined && ts.isIdentifier(enclosingFunction.name)) return enclosingFunction.name.text
	const { parent } = enclosingFunction
	return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : '<anonymous>'
}

// Lists `file:line function` for each website-access write whose function neither reconciles afterwards in its own body nor returns the change it committed, and for each such returned change a caller does not forward.
function findUnreconciledWebsiteAccessWrites(fileName: string) {
	const sourceFile = program.getSourceFile(fileName)
	if (sourceFile === undefined) throw new Error(`Missing source file ${ fileName }`)
	const unreconciled: string[] = []
	const locate = (node: ts.Node, name: string) => `${ fileName.replace(repositoryRoot, '') }:${ sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 } ${ name }`
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = resolveCallee(node)
			const enclosingFunction = getEnclosingFunction(node)
			if (callee !== undefined && websiteAccessWriters.includes(callee)) {
				if (enclosingFunction === undefined) unreconciled.push(locate(node, '<module>'))
				else if (!callsReconcileAfter(enclosingFunction, node.getStart()) && !returnsCommittedAccessChange(enclosingFunction)) unreconciled.push(locate(node, nameOf(enclosingFunction)))
			}
			const valueDeclaration = callee?.valueDeclaration
			const calleeDeclaration = valueDeclaration !== undefined && ts.isVariableDeclaration(valueDeclaration) ? valueDeclaration.initializer : valueDeclaration
			if (calleeDeclaration !== undefined && ts.isFunctionLike(calleeDeclaration) && returnsCommittedAccessChange(calleeDeclaration) && !isChangeForwarded(node)) unreconciled.push(locate(node, `discards ${ callee?.name ?? '' }`))
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return unreconciled
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

// setAddressAccessForWebsite (popup_allowOrPreventAddressAccessForWebsite) writes address consent without reconciling exactly as on main; it is tracked separately and listed here so any other unreconciled write fails.
const KNOWN_UNRECONCILED_WEBSITE_ACCESS_WRITES = ['app/ts/background/popupMessageHandlers/websiteAccess.ts setAddressAccessForWebsite']

test('handler website-access writes reconcile afterwards or hand their committed change to a caller that reconciles it', () => {
	const unreconciled = handlerPaths.flatMap(findUnreconciledWebsiteAccessWrites).map((location) => location.replace(/:\d+ /u, ' '))
	assert.deepEqual(unreconciled, KNOWN_UNRECONCILED_WEBSITE_ACCESS_WRITES)
})

test('the website-access write check rejects unreconciled, discarded, voided and closure-only reconciled writes and accepts reconciled ones', () => {
	assert.deepEqual(findUnreconciledWebsiteAccessWrites(fixtures.writeWithoutReconcile).map((location) => location.replace(/^.*:\d+ /u, '')), ['denyWebsite'])
	assert.deepEqual(findUnreconciledWebsiteAccessWrites(fixtures.discardedChange).map((location) => location.replace(/^.*:\d+ /u, '')), ['discards denyWebsite'])
	assert.deepEqual(findUnreconciledWebsiteAccessWrites(fixtures.voidedChange).map((location) => location.replace(/^.*:\d+ /u, '')), ['discards denyWebsite'])
	assert.deepEqual(findUnreconciledWebsiteAccessWrites(fixtures.reconcileInUncalledClosure).map((location) => location.replace(/^.*:\d+ /u, '')), ['handler'])
	assert.deepEqual(findUnreconciledWebsiteAccessWrites(fixtures.writeThenReconcile), [])
})

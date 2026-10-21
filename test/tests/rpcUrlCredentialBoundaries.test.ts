import * as assert from 'node:assert'
import { test } from 'bun:test'
import ts from 'typescript'

// RPC URLs can embed credentials, so app code reads them raw only to compare them, to hand them to the functions in app/ts/utils/rpcUrlCredentials.ts that own credentials, or at one of the reviewed uses below. A new raw read must either go through redactRpcUrlCredentials or be added here with the reason it is never displayed or logged.
const RAW_RPC_URL_PROPERTIES = new Set(['httpsRpc', 'rpcUrl'])
const CREDENTIAL_OWNING_FUNCTIONS = new Set(['redactRpcUrlCredentials', 'removeRpcUrlCredentials', 'getRpcFetchTarget', 'getRpcUrlCredentialsTransportError'])
const EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

type RawRpcUrlRead = { file: string, enclosingFunction: string, property: string }

// Keyed by enclosing named function rather than line text so reformatting does not break the list; each read is its own entry, so a second raw read in a reviewed function still fails.
const REVIEWED_RAW_RPC_URL_READS: readonly (RawRpcUrlRead & { reason: string })[] = [
	{ file: 'app/ts/background/popupSimulationFingerprint.ts', enclosingFunction: 'normalizeRpcNetworkForFingerprint', property: 'httpsRpc', reason: 'Hashed into the popup fingerprint, never shown.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', enclosingFunction: 'getCurrentSlowRpcRequestForStatus', property: 'httpsRpc', reason: 'Matches slow requests to the active endpoint.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', enclosingFunction: 'publishSlowRpcRequestStatus', property: 'httpsRpc', reason: 'Matches slow requests to the active endpoint.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', enclosingFunction: 'slowRpcRequestKey', property: 'rpcUrl', reason: 'In-memory map key, never shown.' },
	{ file: 'app/ts/components/subcomponents/ConfigureRpcConnection.tsx', enclosingFunction: 'handleFormSubmit', property: 'httpsRpc', reason: 'Saving an edited entry keeps its stored URL; the form only shows it redacted.' },
	{ file: 'app/ts/simulation/serviceLifecycle.ts', enclosingFunction: 'createEthereumClientService', property: 'httpsRpc', reason: 'The request handler sends through getRpcFetchTarget.' },
	{ file: 'app/ts/simulation/services/EthereumJSONRpcRequestHandler.ts', enclosingFunction: 'fetchWithSlowRequestWarning', property: 'rpcUrl', reason: 'Identifies the endpoint of a slow request; background-startup redacts it before reporting.' },
]

function isAssignmentTarget(node: ts.Node) {
	return ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.parent.left === node
}

function isEqualityOperand(node: ts.Node) {
	return ts.isBinaryExpression(node.parent) && EQUALITY_OPERATORS.has(node.parent.operatorToken.kind)
}

function isCredentialOwningFunctionArgument(node: ts.Expression) {
	const call = node.parent
	return ts.isCallExpression(call) && call.arguments.includes(node) && ts.isIdentifier(call.expression) && CREDENTIAL_OWNING_FUNCTIONS.has(call.expression.text)
}

// Identifier, string literal, and computed string literal names all name the same property.
function getStaticPropertyName(name: ts.PropertyName | ts.BindingName) {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
	if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text
	return undefined
}

// An object literal reads properties when it is a destructuring target, as in `({ httpsRpc } = entry)` or `for ({ httpsRpc } of entries)`, including when nested in another target.
function isDestructuringAssignmentTarget(node: ts.Node): boolean {
	const parent = node.parent
	if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node
	if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node
	if (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return isDestructuringAssignmentTarget(parent)
	if (ts.isPropertyAssignment(parent) && parent.initializer === node) return isDestructuringAssignmentTarget(parent.parent)
	return false
}

function getRawRpcUrlPropertyName(node: ts.Node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text
	if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined
	if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) return getStaticPropertyName(node.propertyName ?? node.name)
	if ((ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && isDestructuringAssignmentTarget(node.parent)) return getStaticPropertyName(node.name)
	return undefined
}

function getEnclosingFunctionName(node: ts.Node) {
	for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
		if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) return current.name.getText()
		const isNamedFunctionValue = (ts.isVariableDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isPropertyAssignment(current)) && current.initializer !== undefined && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
		if (isNamedFunctionValue) return current.name.getText()
	}
	return '(module)'
}

function collectUncheckedRawRpcUrlReads(file: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const reads: RawRpcUrlRead[] = []
	const visit = (node: ts.Node) => {
		const property = getRawRpcUrlPropertyName(node)
		if (property !== undefined && RAW_RPC_URL_PROPERTIES.has(property)) {
			// Destructuring is never one of these checked uses, so it is always reported.
			const isCheckedUse = ts.isExpression(node) && (isAssignmentTarget(node) || isEqualityOperand(node) || isCredentialOwningFunctionArgument(node))
			if (!isCheckedUse) reads.push({ file, enclosingFunction: getEnclosingFunctionName(node), property })
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return reads
}

const sortReads = (reads: readonly RawRpcUrlRead[]) => reads.map(({ file, enclosingFunction, property }) => ({ file, enclosingFunction, property })).sort((left, right) => `${ left.file }:${ left.enclosingFunction }:${ left.property }`.localeCompare(`${ right.file }:${ right.enclosingFunction }:${ right.property }`))

async function collectAppRawRpcUrlReads() {
	const appDirectory = new URL('../../', import.meta.url).pathname
	const reads: RawRpcUrlRead[] = []
	for await (const file of new Bun.Glob('app/ts/**/*.{ts,tsx}').scan({ cwd: appDirectory })) {
		reads.push(...collectUncheckedRawRpcUrlReads(file, await Bun.file(`${ appDirectory }${ file }`).text()))
	}
	return sortReads(reads)
}

test('app code reads raw RPC URLs only to compare them, through the credential-owning functions, or at reviewed uses', async () => {
	assert.deepEqual(await collectAppRawRpcUrlReads(), sortReads(REVIEWED_RAW_RPC_URL_READS))
})

test('the raw RPC URL scan flags display, logging, and every destructuring form', () => {
	const source = [
		'function displaysLabel(entry) { return `${ entry.name } (${ entry.httpsRpc })` }',
		'function logsRequest(request) { console.error(request.rpcUrl) }',
		'function readsByBracket(entry) { return entry[\'httpsRpc\'] }',
		'function destructures(entry) { const { httpsRpc } = entry; return httpsRpc }',
		'function destructuresStringName(entry) { const { \'httpsRpc\': leaked } = entry; return leaked }',
		'function destructuresComputedName(entry) { const { [\'httpsRpc\']: leaked } = entry; return leaked }',
		'function destructuresNested(settings) { const { network: { httpsRpc } } = settings; return httpsRpc }',
		'function assignsByDestructuring(entry) { let httpsRpc; ({ httpsRpc } = entry); return httpsRpc }',
		'function assignsStringNameByDestructuring(request) { let leaked; ({ \'rpcUrl\': leaked } = request); return leaked }',
		'function assignsComputedNameByDestructuring(entry) { let leaked; ({ [\'httpsRpc\']: leaked } = entry); return leaked }',
		'function assignsNestedByDestructuring(entries) { let httpsRpc; [{ httpsRpc }] = entries; return httpsRpc }',
		'function destructuresInLoop(entries) { let httpsRpc; for ({ httpsRpc } of entries) console.log(httpsRpc) }',
		'function compares(entry, other) { return entry.httpsRpc === other.httpsRpc }',
		'function redacts(entry) { return redactRpcUrlCredentials(entry.httpsRpc) }',
		'function writes(handler, rpcUrl) { handler.rpcUrl = rpcUrl }',
		'function buildsEntry(url) { return { httpsRpc: url } }',
	].join('\n')
	assert.deepEqual(collectUncheckedRawRpcUrlReads('example.ts', source).map(({ enclosingFunction, property }) => `${ enclosingFunction }.${ property }`), [
		'displaysLabel.httpsRpc',
		'logsRequest.rpcUrl',
		'readsByBracket.httpsRpc',
		'destructures.httpsRpc',
		'destructuresStringName.httpsRpc',
		'destructuresComputedName.httpsRpc',
		'destructuresNested.httpsRpc',
		'assignsByDestructuring.httpsRpc',
		'assignsStringNameByDestructuring.rpcUrl',
		'assignsComputedNameByDestructuring.httpsRpc',
		'assignsNestedByDestructuring.httpsRpc',
		'destructuresInLoop.httpsRpc',
	])
})

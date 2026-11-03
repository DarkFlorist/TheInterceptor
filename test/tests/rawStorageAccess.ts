import * as ts from 'typescript'

// How a module may use the browser storage API directly. Every module may read through a direct browser.storage.local.get call and listen through browser.storage.onChanged. Only the counted writer, storageUtils.ts, and reviewed writers of other keys may call browser.storage.local.set or remove directly, and a reviewed writer must never name the active network.
export type RawStorageAccess = 'counted writer' | 'reviewed writer of other keys' | 'reads only'

const browserApiNames = new Set(['browser', 'chrome'])
const allowedStorageCalls: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['local', new Set(['get', 'set', 'remove'])],
	['onChanged', new Set(['addListener', 'removeListener'])],
])
const rawWriteCalls = new Set(['set', 'remove'])

// The property access whose name is the given node, when the node is the name of one.
const getAccessNamedBy = (node: ts.Node) => ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : undefined
// The property access on the given expression, when the expression is the object of one.
const getAccessOn = (expression: ts.Node) => ts.isPropertyAccessExpression(expression.parent) && expression.parent.expression === expression ? expression.parent : undefined

// Whether the browser API object is the first argument of a call to one of the given callees, which are reviewed to use it only as an identity key.
function isPassedAsIdentityKey(apiObject: ts.Expression, identityKeyCallees: ReadonlySet<string>) {
	const call = apiObject.parent
	return ts.isCallExpression(call) && call.arguments[0] === apiObject && ts.isIdentifier(call.expression) && identityKeyCallees.has(call.expression.text)
}

// Checks one browser or chrome reference: it must be the object of a property access, unless it is passed as an identity key, and when that property is storage, the whole access must be a direct call of an allowed storage method. Returns a description of the violation, or undefined.
function checkBrowserApiReference(reference: ts.Identifier, access: RawStorageAccess, identityKeyCallees: ReadonlySet<string>): string | undefined {
	// browser.storage.StorageChange and other type positions are erased at runtime.
	if (ts.isQualifiedName(reference.parent)) return undefined
	const apiObject = getAccessNamedBy(reference) ?? reference
	const apiAccess = getAccessOn(apiObject)
	if (apiAccess === undefined && isPassedAsIdentityKey(apiObject, identityKeyCallees)) return undefined
	if (apiAccess === undefined) return `uses ${ reference.text } other than through a property access, which could hide a storage write`
	if (apiAccess.name.text !== 'storage') return undefined
	const storageArea = getAccessOn(apiAccess)
	const method = storageArea === undefined ? undefined : getAccessOn(storageArea)
	const allowedMethods = storageArea === undefined ? undefined : allowedStorageCalls.get(storageArea.name.text)
	const isDirectCall = method !== undefined && ts.isCallExpression(method.parent) && method.parent.expression === method
	if (storageArea === undefined || method === undefined || allowedMethods === undefined || !allowedMethods.has(method.name.text) || !isDirectCall) return `uses ${ reference.text }.storage other than through a direct call of local.get, local.set, local.remove or onChanged listeners`
	if (storageArea.name.text === 'local' && rawWriteCalls.has(method.name.text) && access === 'reads only') return `calls ${ reference.text }.storage.local.${ method.name.text } directly outside the listed storage writers`
	return undefined
}

// Lists, with their line numbers, the uses of the browser storage API in a source file that could change the stored active network without passing through the counted writer in storageUtils.ts. Syntactic: it finds the storage API only where the code names browser or chrome. identityKeyCallees names the functions that may receive browser or chrome itself as their first argument because they only use it as an identity key.
export function findUncountedStorageAccess(fileName: string, sourceText: string, access: RawStorageAccess, identityKeyCallees: ReadonlySet<string> = new Set()): readonly string[] {
	const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const violations: string[] = []
	const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && browserApiNames.has(node.text)) {
			const violation = checkBrowserApiReference(node, access, identityKeyCallees)
			if (violation !== undefined) violations.push(`line ${ lineOf(node) }: ${ violation }`)
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	if (access === 'reviewed writer of other keys' && /\bactiveRpcNetwork\b/u.test(sourceText)) violations.push('names activeRpcNetwork although it writes browser storage directly, outside the counted writer')
	return violations
}

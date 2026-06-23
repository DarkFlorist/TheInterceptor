import process from 'node:process'
import ts from 'typescript'

const defaultFilePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx'] as const

type Diagnostic = { file: string, line: number, column: number, text: string }
type Scope = { reportValues: Map<string, boolean> }

function scriptKindForPath(path: string) {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

function diagnosticForNode(sourceFile: ts.SourceFile, node: ts.Node): Diagnostic {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
	return {
		file: sourceFile.fileName,
		line: line + 1,
		column: character + 1,
		text: node.getText(sourceFile),
	}
}

function skipParentheses(expression: ts.Expression): ts.Expression {
	let current = expression
	while (ts.isParenthesizedExpression(current)) current = current.expression
	return current
}

function isReportUnexpectedErrorCall(node: ts.Node): node is ts.CallExpression {
	return ts.isCallExpression(node)
		&& ts.isIdentifier(node.expression)
		&& node.expression.text === 'reportUnexpectedError'
}

function isMessagePropertyName(name: ts.PropertyName): boolean {
	if (ts.isIdentifier(name)) return name.text === 'message'
	if (ts.isStringLiteralLike(name)) return name.text === 'message'
	return false
}

function isMessageObjectLiteral(expression: ts.Expression) {
	if (!ts.isObjectLiteralExpression(expression)) return false
	return expression.properties.some((property) => {
		if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) return isMessagePropertyName(property.name)
		return false
	})
}

function isWrappedReportExpression(expression: ts.Expression) {
	expression = skipParentheses(expression)
	if (ts.isNewExpression(expression)) return true
	if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'Error') return true
	return isMessageObjectLiteral(expression)
}

function isWrappedIdentifier(expression: ts.Expression, scopes: readonly Scope[]) {
	expression = skipParentheses(expression)
	if (!ts.isIdentifier(expression)) return false
	for (const scope of scopes) {
		const wrapped = scope.reportValues.get(expression.text)
		if (wrapped !== undefined) return wrapped
	}
	return false
}

function isWrappedErrorReport(node: ts.CallExpression, scopes: readonly Scope[]) {
	const firstArgument = node.arguments[0]
	if (firstArgument === undefined) return false
	return isWrappedReportExpression(firstArgument) || isWrappedIdentifier(firstArgument, scopes)
}

function isAllowedReportUsage(node: ts.CallExpression) {
	let expression: ts.Node = node
	while (expression.parent !== undefined && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
	const parent = expression.parent
	if (parent === undefined) return false
	if (ts.isAwaitExpression(parent)) return true
	if (ts.isVoidExpression(parent)) return true
	if (ts.isReturnStatement(parent)) return true
	return false
}

function collectDiagnostics(path: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const unhandledDiagnostics: Diagnostic[] = []
	const wrappedDiagnostics: Diagnostic[] = []
	const scopes: Scope[] = []

	const visit = (node: ts.Node) => {
		const isScopeBoundary = ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
		if (isScopeBoundary) scopes.unshift({ reportValues: new Map() })
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			scopes[0]?.reportValues.set(node.name.text, node.initializer === undefined ? false : isWrappedReportExpression(node.initializer) || isWrappedIdentifier(node.initializer, scopes))
		}
		if (isReportUnexpectedErrorCall(node)) {
			if (isWrappedErrorReport(node, scopes)) wrappedDiagnostics.push(diagnosticForNode(sourceFile, node))
			if (!isAllowedReportUsage(node)) unhandledDiagnostics.push(diagnosticForNode(sourceFile, node))
		}
		ts.forEachChild(node, visit)
		if (isScopeBoundary) scopes.shift()
	}

	visit(sourceFile)
	return { unhandledDiagnostics, wrappedDiagnostics }
}

async function getFilePaths() {
	const explicitPaths = process.argv.slice(2)
	if (explicitPaths.length > 0) return explicitPaths

	const filePaths = new Set<string>()
	for (const pattern of defaultFilePatterns) {
		for await (const path of new Bun.Glob(pattern).scan('.')) {
			filePaths.add(path)
		}
	}
	return [...filePaths].sort()
}

const unhandledDiagnostics: Diagnostic[] = []
const wrappedDiagnostics: Diagnostic[] = []
for (const path of await getFilePaths()) {
	const sourceText = await Bun.file(path).text()
	const diagnostics = collectDiagnostics(path, sourceText)
	unhandledDiagnostics.push(...diagnostics.unhandledDiagnostics)
	wrappedDiagnostics.push(...diagnostics.wrappedDiagnostics)
}

if (unhandledDiagnostics.length > 0 || wrappedDiagnostics.length > 0) {
	if (wrappedDiagnostics.length > 0) {
		console.error('reportUnexpectedError must receive the original caught value. Do not wrap errors before reporting.')
		for (const diagnostic of wrappedDiagnostics) {
			console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
		}
	}
	if (unhandledDiagnostics.length > 0) {
		console.error('reportUnexpectedError calls must be awaited, returned, or explicitly voided.')
		for (const diagnostic of unhandledDiagnostics) {
			console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
		}
	}
	process.exit(1)
}

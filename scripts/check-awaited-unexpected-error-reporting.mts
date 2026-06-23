import process from 'node:process'
import ts from 'typescript'

const defaultFilePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx'] as const

type Diagnostic = { file: string, line: number, column: number, text: string }

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

function isWrappedErrorReport(node: ts.CallExpression) {
	const firstArgument = node.arguments[0]
	if (firstArgument === undefined) return false
	const expression = skipParentheses(firstArgument)
	return ts.isNewExpression(expression)
		&& ts.isIdentifier(expression.expression)
		&& expression.expression.text === 'Error'
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

	const visit = (node: ts.Node) => {
		if (isReportUnexpectedErrorCall(node)) {
			if (isWrappedErrorReport(node)) wrappedDiagnostics.push(diagnosticForNode(sourceFile, node))
			if (!isAllowedReportUsage(node)) unhandledDiagnostics.push(diagnosticForNode(sourceFile, node))
		}
		ts.forEachChild(node, visit)
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

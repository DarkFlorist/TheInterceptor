import process from 'node:process'
import ts from 'typescript'

const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx'] as const
const allowedFiles = new Set(['app/ts/utils/errors.ts'])
const allowedComments = ['error-reporting: console-only']

type Diagnostic = { file: string, line: number, column: number, text: string }

function scriptKindForPath(path: string) {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

function hasAllowedComment(sourceText: string, node: ts.Node) {
	return allowedComments.some((comment) => sourceText.slice(node.getFullStart(), node.getEnd()).includes(comment))
}

function isPrintErrorCall(node: ts.CallExpression) {
	return ts.isIdentifier(node.expression) && node.expression.text === 'printError'
}

function isConsoleErrorCall(node: ts.CallExpression) {
	if (!ts.isPropertyAccessExpression(node.expression)) return false
	return ts.isIdentifier(node.expression.expression)
		&& node.expression.expression.text === 'console'
		&& node.expression.name.text === 'error'
}

function collectConsoleErrorCatchDiagnostics(path: string, sourceText: string) {
	if (allowedFiles.has(path)) return []
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []

	function visitCatch(catchClause: ts.CatchClause) {
		if (hasAllowedComment(sourceText, catchClause.block)) return
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && (isPrintErrorCall(node) || isConsoleErrorCall(node))) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
				diagnostics.push({ file: path, line: line + 1, column: character + 1, text: node.getText(sourceFile) })
			}
			ts.forEachChild(node, visit)
		}
		visit(catchClause.block)
	}

	const visit = (node: ts.Node) => {
		if (ts.isCatchClause(node)) visitCatch(node)
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return diagnostics
}

const filePaths = new Set<string>()
for (const pattern of filePatterns) {
	for await (const path of new Bun.Glob(pattern).scan('.')) {
		filePaths.add(path)
	}
}

const diagnostics = []
for (const path of [...filePaths].sort()) {
	const sourceText = await Bun.file(path).text()
	diagnostics.push(...collectConsoleErrorCatchDiagnostics(path, sourceText))
}

if (diagnostics.length > 0) {
	console.error('console.error and printError inside catch blocks must use a reporting helper. Use reportLocalRecovery for local fallback paths.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

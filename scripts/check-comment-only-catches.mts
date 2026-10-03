import process from 'node:process'
import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from './typescript-lint-utils.mts'

const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'app/inpage/ts/**/*.ts', 'test/**/*.ts', 'build/**/*.mts'] as const

const collectCommentOnlyCatchDiagnostics = (path: string, sourceText: string) => {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: { file: string, line: number, column: number }[] = []

	const visit = (node: ts.Node) => {
		if (ts.isCatchClause(node) && node.block.statements.length === 0) {
			const bodyStart = node.block.getStart(sourceFile) + 1
			const bodyEnd = node.block.getEnd() - 1
			const bodyText = sourceText.slice(bodyStart, bodyEnd).trim()
			if (bodyText.length > 0) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
				diagnostics.push({ file: path, line: line + 1, column: character + 1 })
			}
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return diagnostics
}

const diagnostics = []
for (const path of await collectFilePaths(filePatterns)) {
	const sourceText = await Bun.file(path).text()
	diagnostics.push(...collectCommentOnlyCatchDiagnostics(path, sourceText))
}

if (diagnostics.length > 0) {
	console.error('Comment-only catch blocks are not allowed. Handle the error explicitly or remove the catch.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }`)
	}
	process.exit(1)
}

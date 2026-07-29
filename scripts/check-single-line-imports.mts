import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from './typescript-lint-utils.mts'

const filePatterns = [
	'app/ts/**/*.ts',
	'app/ts/**/*.tsx',
	'app/inpage/ts/**/*.ts',
	'test/**/*.ts',
	'test/**/*.tsx',
	'build/**/*.mts',
	'scripts/**/*.ts',
	'scripts/**/*.mts',
] as const

export type MultilineImportDiagnostic = {
	file: string
	line: number
	column: number
}

export function collectMultilineNamedImportDiagnostics(path: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: MultilineImportDiagnostic[] = []

	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue
		const namedBindings = statement.importClause?.namedBindings
		if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) continue
		const start = sourceFile.getLineAndCharacterOfPosition(namedBindings.getStart(sourceFile))
		const end = sourceFile.getLineAndCharacterOfPosition(namedBindings.getEnd())
		if (start.line === end.line) continue
		diagnostics.push({ file: path, line: start.line + 1, column: start.character + 1 })
	}

	return diagnostics
}

if (import.meta.main) {
	const diagnostics = []
	for (const path of await collectFilePaths(filePatterns)) {
		diagnostics.push(...collectMultilineNamedImportDiagnostics(path, await Bun.file(path).text()))
	}

	if (diagnostics.length > 0) {
		console.error('Named imports must stay on a single line.')
		for (const diagnostic of diagnostics) {
			console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }`)
		}
		process.exit(1)
	}
}

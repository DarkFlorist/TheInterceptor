import process from 'node:process'
import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from './typescript-lint-utils.mts'

// User-facing amounts use SI prefixes on ether (ether, nanoeth, attoeth); "wei" and "gwei" must not appear in any text.
const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'app/inpage/ts/**/*.ts']
const forbiddenUnitPattern = /\b(?:g?wei)\b/iu

type Diagnostic = { file: string, line: number, column: number, text: string }

function collectDiagnostics(path: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []
	const report = (node: ts.Node) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
		diagnostics.push({ file: path, line: line + 1, column: character + 1, text: node.getText(sourceFile).trim() })
	}
	const visit = (node: ts.Node) => {
		const isText = ts.isStringLiteral(node)
			|| ts.isNoSubstitutionTemplateLiteral(node)
			|| ts.isTemplateHead(node)
			|| ts.isTemplateMiddle(node)
			|| ts.isTemplateTail(node)
			|| ts.isJsxText(node)
		if (isText && forbiddenUnitPattern.test(node.text)) report(node)
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	for (const comment of sourceText.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu)) {
		if (!forbiddenUnitPattern.test(comment[0])) continue
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(comment.index)
		diagnostics.push({ file: path, line: line + 1, column: character + 1, text: comment[0].trim() })
	}
	return diagnostics
}

const diagnostics: Diagnostic[] = []
for (const path of await collectFilePaths(filePatterns)) {
	const sourceText = await Bun.file(path).text()
	diagnostics.push(...collectDiagnostics(path, sourceText))
}

if (diagnostics.length > 0) {
	console.error('Use SI units for ether amounts (ether, nanoeth, attoeth) instead of wei or gwei.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

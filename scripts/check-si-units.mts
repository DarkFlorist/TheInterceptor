import process from 'node:process'
import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from './typescript-lint-utils.mts'

// Ether amounts use SI prefixes (ether, nanoeth, attoeth); "wei" and "gwei" must not appear in text, comments, or identifiers.
const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'app/inpage/ts/**/*.ts']
const forbiddenUnitPattern = /\b(?:g?wei)\b/iu
const forbiddenUnitWords = new Set(['wei', 'gwei'])

type Diagnostic = { file: string, line: number, column: number, text: string }

// Identifiers are split on camelCase and snake_case boundaries so `maxFeePerGasWei` is caught while `weight` is not.
function identifierUsesForbiddenUnit(identifier: string) {
	return identifier.split(/(?=[A-Z])|_+/u).some((word) => forbiddenUnitWords.has(word.toLowerCase()))
}

function collectDiagnostics(path: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []
	const reportedCommentStarts = new Set<number>()
	const report = (start: number, text: string) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
		diagnostics.push({ file: path, line: line + 1, column: character + 1, text: text.trim() })
	}
	const reportComments = (ranges: readonly ts.CommentRange[] | undefined) => {
		for (const range of ranges ?? []) {
			if (reportedCommentStarts.has(range.pos)) continue
			reportedCommentStarts.add(range.pos)
			const comment = sourceText.slice(range.pos, range.end)
			if (forbiddenUnitPattern.test(comment)) report(range.pos, comment)
		}
	}
	const visit = (node: ts.Node) => {
		reportComments(ts.getLeadingCommentRanges(sourceText, node.getFullStart()))
		reportComments(ts.getTrailingCommentRanges(sourceText, node.getEnd()))
		const isText = ts.isStringLiteral(node)
			|| ts.isNoSubstitutionTemplateLiteral(node)
			|| ts.isTemplateHead(node)
			|| ts.isTemplateMiddle(node)
			|| ts.isTemplateTail(node)
			|| ts.isJsxText(node)
		if (isText && forbiddenUnitPattern.test(node.text)) report(node.getStart(sourceFile), node.getText(sourceFile))
		if (ts.isIdentifier(node) && identifierUsesForbiddenUnit(node.text)) report(node.getStart(sourceFile), node.text)
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return diagnostics.sort((left, right) => left.line - right.line || left.column - right.column)
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

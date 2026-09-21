import process from 'node:process'
import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from './typescript-lint-utils.mts'

// Ether amounts use SI prefixes (ether, nanoeth, attoeth); "wei" and "gwei" must not appear in text, comments, or identifiers.
const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'app/inpage/ts/**/*.ts']
const forbiddenUnitPattern = /\b(?:g?wei)\b/iu
const forbiddenUnitWords = new Set(['wei', 'gwei'])

export type ForbiddenUnitDiagnostic = { file: string, line: number, column: number, text: string }

// Words are extracted from camelCase, SCREAMING_CASE, snake_case, and digit boundaries so `maxFeePerGasWei` and `WEI_PER_ETH` are caught while `weight` is not.
function identifierUsesForbiddenUnit(identifier: string) {
	const words = identifier.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/gu) ?? []
	return words.some((word) => forbiddenUnitWords.has(word.toLowerCase()))
}

export function collectForbiddenUnitDiagnostics(file: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(file))
	const diagnostics: ForbiddenUnitDiagnostic[] = []
	const reportedCommentStarts = new Set<number>()
	const report = (start: number, text: string) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
		diagnostics.push({ file, line: line + 1, column: character + 1, text: text.trim() })
	}
	const reportComments = (ranges: readonly ts.CommentRange[] | undefined) => {
		for (const range of ranges ?? []) {
			if (reportedCommentStarts.has(range.pos)) continue
			reportedCommentStarts.add(range.pos)
			const comment = sourceText.slice(range.pos, range.end)
			if (forbiddenUnitPattern.test(comment)) report(range.pos, comment)
		}
	}
	// Tokens are visited as well as nodes, because a comment after `{`, `(`, or `:` is only reachable from that token's position.
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
		// Identifiers inside JSDoc (such as `@param` names) are already covered by the comment report, so skip them to avoid duplicates.
		const isJsDocIdentifier = (node.flags & ts.NodeFlags.JSDoc) !== 0
		if (!isJsDocIdentifier && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && identifierUsesForbiddenUnit(node.text)) report(node.getStart(sourceFile), node.text)
		for (const child of node.getChildren(sourceFile)) visit(child)
	}
	visit(sourceFile)
	return diagnostics.sort((left, right) => left.line - right.line || left.column - right.column)
}

if (import.meta.main) {
	const diagnostics: ForbiddenUnitDiagnostic[] = []
	for (const path of await collectFilePaths(filePatterns)) {
		const sourceText = await Bun.file(path).text()
		diagnostics.push(...collectForbiddenUnitDiagnostics(path, sourceText))
	}

	if (diagnostics.length > 0) {
		console.error('Use SI units for ether amounts (ether, nanoeth, attoeth) instead of wei or gwei.')
		for (const diagnostic of diagnostics) {
			console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
		}
		process.exit(1)
	}
}

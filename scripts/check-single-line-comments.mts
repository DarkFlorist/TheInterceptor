import ts from 'typescript'
import { collectFilePaths } from './typescript-lint-utils.mts'

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

// This locally derived source mirrors upstream generated data and preserves its comment layout as provenance.
const excludedPaths = new Set(['app/ts/utils/ensNormalize.ts'])

export type SplitCommentDiagnostic = {
	file: string
	line: number
	column: number
}

const structuredComment = /(?:https?:\/\/|^(?:biome|c8|istanbul|eslint|prettier)-|^(?:Copyright\b|SPDX-|SHA-256:|[0-9]+[.)]\s|[-*]\s|@|TODO\b|FIXME\b)|^(?:source|see|original|licenses?|created|compressed)\b)/iu
const codeDeclarationStart = /^(?:const|let|var|function|class|interface|type|enum|export|import)\b/u
const codeControlFlowStart = /^(?:if|for|while|switch|catch)\s*\(|^(?:else|try|finally|do)\b/u

function isCommentedCode(content: string) {
	if (codeDeclarationStart.test(content) || codeControlFlowStart.test(content)) return true
	if (!/^(?:return|throw)\b/u.test(content) && !/[();={}\[\]]/u.test(content)) return false
	const result = ts.transpileModule(content, {
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.Latest },
	})
	return (result.diagnostics?.length ?? 0) === 0
}

function isProseComment(content: string) {
	if (content.length === 0 || structuredComment.test(content) || isCommentedCode(content)) return false
	if (/^[}\])>;]|[{}]$/u.test(content)) return false
	return /[A-Za-z]/u.test(content)
}

function getCommentLine(line: string) {
	const match = /^(\s*)\/\/ (.*)$/u.exec(line)
	if (match?.[1] === undefined || match[2] === undefined) return undefined
	return { indentation: match[1], content: match[2] }
}

export function fixSplitProseComments(sourceText: string) {
	const lines = sourceText.split('\n')
	const fixedLines: string[] = []
	for (const line of lines) {
		const previousLine = fixedLines.at(-1)
		const previousComment = previousLine === undefined ? undefined : getCommentLine(previousLine)
		const comment = getCommentLine(line)
		if (
			previousComment !== undefined
			&& comment !== undefined
			&& previousComment.indentation === comment.indentation
			&& isProseComment(previousComment.content)
			&& isProseComment(comment.content)
		) {
			const separator = previousComment.content.endsWith('-') ? '' : ' '
			fixedLines[fixedLines.length - 1] = `${ previousLine }${ separator }${ comment.content }`
			continue
		}
		fixedLines.push(line)
	}
	return fixedLines.join('\n')
}

export function collectSplitCommentDiagnostics(file: string, sourceText: string) {
	const diagnostics: SplitCommentDiagnostic[] = []
	const lines = sourceText.split('\n')
	for (let index = 1; index < lines.length; index++) {
		const previousComment = getCommentLine(lines[index - 1] ?? '')
		const comment = getCommentLine(lines[index] ?? '')
		if (
			previousComment !== undefined
			&& comment !== undefined
			&& previousComment.indentation === comment.indentation
			&& isProseComment(previousComment.content)
			&& isProseComment(comment.content)
		) {
			diagnostics.push({ file, line: index + 1, column: comment.indentation.length + 1 })
		}
	}
	return diagnostics
}

if (import.meta.main) {
	const write = process.argv.includes('--write')
	const diagnostics: SplitCommentDiagnostic[] = []
	for (const path of await collectFilePaths(filePatterns)) {
		if (excludedPaths.has(path)) continue
		const sourceText = await Bun.file(path).text()
		const fileDiagnostics = collectSplitCommentDiagnostics(path, sourceText)
		if (write && fileDiagnostics.length > 0) {
			await Bun.write(path, fixSplitProseComments(sourceText))
		} else {
			diagnostics.push(...fileDiagnostics)
		}
	}

	if (diagnostics.length > 0) {
		console.error('Prose comments must stay on a single line. Run `bun run lint:comments:fix` to fix them.')
		for (const diagnostic of diagnostics) {
			console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }`)
		}
		process.exit(1)
	}
}

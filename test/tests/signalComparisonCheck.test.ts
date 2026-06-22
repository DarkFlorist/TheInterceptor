import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'

const SOURCE_ROOT = join(process.cwd(), 'app', 'ts')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

async function listSourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		const fullPath = join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...await listSourceFiles(fullPath))
			continue
		}
		const extension = entry.name.slice(entry.name.lastIndexOf('.'))
		if (SOURCE_EXTENSIONS.has(extension)) files.push(fullPath)
	}
	return files
}

function findSignalVariableDeclarations(source: string) {
	const declarations: Array<{ name: string, lineIndex: number }> = []
	for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:useSignal|useComputed|new\s+Signal)\b/g)) {
		const lineIndex = source.slice(0, match.index).split('\n').length - 1
		declarations.push({ name: match[1], lineIndex })
	}
	return declarations
}

function findDirectSignalComparisons(source: string, filePath: string): string[] {
	const signalDeclarations = findSignalVariableDeclarations(source)
	const failures: string[] = []
	const lines = source.split('\n')
	for (const declaration of signalDeclarations) {
		const directComparisonPattern = new RegExp(`(^|[^.])\\b${ declaration.name }\\b\\s*(?:===|!==|==|!=)\\s*(?:undefined|null)|(?:undefined|null)\\s*(?:===|!==|==|!=)\\s*\\b${ declaration.name }\\b`)
		for (const [lineIndex, line] of lines.entries()) {
			if (lineIndex <= declaration.lineIndex) continue
			if (line.includes('.value')) continue
			if (!directComparisonPattern.test(line)) continue
			const nearbyLines = lines.slice(Math.max(declaration.lineIndex + 1, lineIndex - 8), lineIndex)
			if (nearbyLines.some((candidateLine) => new RegExp(`\\b${ declaration.name }\\b\\s*(?:[:,)\\]}]|=>)`).test(candidateLine))) continue
			const shadowed = lines.slice(declaration.lineIndex + 1, lineIndex).some((candidateLine) => (
				new RegExp(`\\b(?:const|let|function|class|catch|for)\\s+${ declaration.name }\\b`).test(candidateLine)
			))
			if (shadowed) continue
			failures.push(`${ relative(process.cwd(), filePath) }:${ lineIndex + 1 }: ${ line.trim() }`)
		}
	}
	return failures
}

describe('signal comparison safety check', () => {
	test('does not compare signal wrappers directly to undefined or null', async () => {
		const files = await listSourceFiles(SOURCE_ROOT)
		const failures = (await Promise.all(files.map(async (filePath) => {
			const source = await readFile(filePath, 'utf8')
			return findDirectSignalComparisons(source, filePath)
		}))).flat()

		assert.deepEqual(failures, [])
	})
})

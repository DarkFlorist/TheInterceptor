import process from 'node:process'

const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx', 'test/**/*.ts'] as const
const disallowedPatterns = [
	/[\w.]+\s+instanceof\s+Error\s*\)?\s*&&\s*\(?\s*isNewBlockAbort\s*\(/g,
	/isNewBlockAbort\s*\([^)]*\)\s*\)?\s*&&\s*\(?\s*[\w.]+\s+instanceof\s+Error/g,
]

const diagnostics: { file: string, line: number, text: string }[] = []

function getLineNumber(sourceText: string, index: number) {
	return sourceText.slice(0, index).split('\n').length
}

function getLineText(sourceText: string, lineNumber: number) {
	return sourceText.split('\n')[lineNumber - 1]?.trim() ?? ''
}

for (const pattern of filePatterns) {
	for await (const path of new Bun.Glob(pattern).scan('.')) {
		const sourceText = await Bun.file(path).text()
		for (const disallowedPattern of disallowedPatterns) {
			for (const match of sourceText.matchAll(disallowedPattern)) {
				const lineNumber = getLineNumber(sourceText, match.index)
				diagnostics.push({
					file: path,
					line: lineNumber,
					text: getLineText(sourceText, lineNumber),
				})
			}
		}
	}
}

if (diagnostics.length > 0) {
	console.error('New-block abort checks must use isNewBlockAbort(error) directly. The helper accepts unknown values.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

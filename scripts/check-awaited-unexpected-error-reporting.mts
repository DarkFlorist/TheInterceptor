import process from 'node:process'

const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx'] as const
const allowedPrefixes = ['await ', 'return ', 'void ']
const diagnostics: { file: string, line: number, text: string }[] = []

function isHandleUnexpectedErrorDeclaration(line: string) {
	return line.includes('function handleUnexpectedError(')
}

function isAllowedCall(line: string, index: number) {
	const prefix = line.slice(0, index).trimEnd()
	return allowedPrefixes.some((allowedPrefix) => prefix.endsWith(allowedPrefix.trimEnd()))
}

for (const pattern of filePatterns) {
	for await (const path of new Bun.Glob(pattern).scan('.')) {
		const sourceText = await Bun.file(path).text()
		const lines = sourceText.split('\n')
		for (const [index, line] of lines.entries()) {
			if (isHandleUnexpectedErrorDeclaration(line)) continue
			const callIndex = line.indexOf('handleUnexpectedError(')
			if (callIndex === -1) continue
			if (isAllowedCall(line, callIndex)) continue
			diagnostics.push({ file: path, line: index + 1, text: line.trim() })
		}
	}
}

if (diagnostics.length > 0) {
	console.error('handleUnexpectedError calls must be awaited, returned, or explicitly voided.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

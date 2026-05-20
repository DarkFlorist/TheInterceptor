import process from 'node:process'
import ts from 'typescript'

const shouldWrite = process.argv.includes('--write')

const filePatterns = [
	'app/ts/**/*.ts',
	'app/ts/**/*.tsx',
	'app/inpage/ts/**/*.ts',
	'test/**/*.ts',
	'build/**/*.mts',
	'scripts/**/*.ts',
	'scripts/**/*.mts',
] as const

type Diagnostic = {
	file: string
	line: number
	column: number
}

type Replacement = {
	start: number
	end: number
	text: string
}

const scriptKindForPath = (path: string) => {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

const escapeForSingleQuotedString = (value: string) => {
	let escaped = ''

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]
		switch (character) {
			case '\\':
				escaped += '\\\\'
				break
			case '\'':
				escaped += '\\\''
				break
			case '\0':
				escaped += /[0-9]/.test(value[index + 1] ?? '') ? '\\x00' : '\\0'
				break
			case '\b':
				escaped += '\\b'
				break
			case '\f':
				escaped += '\\f'
				break
			case '\n':
				escaped += '\\n'
				break
			case '\r':
				escaped += '\\r'
				break
			case '\t':
				escaped += '\\t'
				break
			case '\v':
				escaped += '\\v'
				break
			case '\u2028':
				escaped += '\\u2028'
				break
			case '\u2029':
				escaped += '\\u2029'
				break
			default: {
				const codePoint = character.charCodeAt(0)
				escaped += codePoint < 0x20 ? `\\x${ codePoint.toString(16).padStart(2, '0') }` : character
			}
		}
	}

	return `'${ escaped }'`
}

const collectQuoteDiagnostics = (path: string, sourceText: string) => {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []
	const replacements: Replacement[] = []

	const visit = (node: ts.Node) => {
		if (ts.isStringLiteral(node)) {
			const text = node.getText(sourceFile)
			if (text.startsWith('"')) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
				diagnostics.push({ file: path, line: line + 1, column: character + 1 })
				replacements.push({
					start: node.getStart(sourceFile),
					end: node.getEnd(),
					text: escapeForSingleQuotedString(node.text),
				})
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return { diagnostics, replacements }
}

const filePaths = new Set<string>()
for (const pattern of filePatterns) {
	for await (const path of new Bun.Glob(pattern).scan('.')) {
		filePaths.add(path)
	}
}

const diagnostics: Diagnostic[] = []
let updatedFiles = 0
let updatedLiterals = 0

for (const path of [...filePaths].sort()) {
	const sourceText = await Bun.file(path).text()
	const { diagnostics: fileDiagnostics, replacements } = collectQuoteDiagnostics(path, sourceText)
	diagnostics.push(...fileDiagnostics)

	if (!shouldWrite || replacements.length === 0) continue

	let updatedSourceText = sourceText
	for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
		updatedSourceText = `${ updatedSourceText.slice(0, replacement.start) }${ replacement.text }${ updatedSourceText.slice(replacement.end) }`
	}

	if (updatedSourceText === sourceText) continue

	await Bun.write(path, updatedSourceText)
	updatedFiles += 1
	updatedLiterals += replacements.length
}

if (shouldWrite) {
	if (updatedFiles > 0) console.log(`Rewrote ${ updatedLiterals } string literals across ${ updatedFiles } files.`)
	process.exit(0)
}

if (diagnostics.length > 0) {
	console.error('Double-quoted string literals are not allowed. Use single quotes instead.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }`)
	}
	process.exit(1)
}

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
	message: string
}

type Replacement = {
	position: number
	text: string
}

const scriptKindForPath = (path: string) => {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

const collectTemplateInterpolationSpacingDiagnostics = (path: string, sourceText: string) => {
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []
	const replacements: Replacement[] = []

	const pushDiagnostic = (position: number, message: string) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(position)
		diagnostics.push({ file: path, line: line + 1, column: character + 1, message })
	}

	const validateTemplateExpression = (templateExpression: ts.TemplateExpression) => {
		for (const span of templateExpression.templateSpans) {
			const expressionStart = span.expression.getStart(sourceFile)
			const expressionEnd = span.expression.getEnd()

			if (sourceText[expressionStart - 1] !== ' ') {
				pushDiagnostic(expressionStart - 2, 'Expected a space after `${` in a template interpolation.')
				replacements.push({ position: expressionStart, text: ' ' })
			}

			if (sourceText[expressionEnd] !== ' ') {
				pushDiagnostic(expressionEnd, 'Expected a space before `}` in a template interpolation.')
				replacements.push({ position: expressionEnd, text: ' ' })
			}
		}
	}

	const visit = (node: ts.Node) => {
		if (ts.isTemplateExpression(node)) validateTemplateExpression(node)

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
let updatedInterpolations = 0
for (const path of [...filePaths].sort()) {
	const sourceText = await Bun.file(path).text()
	const { diagnostics: fileDiagnostics, replacements } = collectTemplateInterpolationSpacingDiagnostics(path, sourceText)
	diagnostics.push(...fileDiagnostics)

	if (!shouldWrite || replacements.length === 0) continue

	let updatedSourceText = sourceText
	for (const replacement of replacements.toSorted((left, right) => right.position - left.position)) {
		updatedSourceText = `${ updatedSourceText.slice(0, replacement.position) }${ replacement.text }${ updatedSourceText.slice(replacement.position) }`
	}

	if (updatedSourceText === sourceText) continue

	await Bun.write(path, updatedSourceText)
	updatedFiles += 1
	updatedInterpolations += replacements.length
}

if (shouldWrite) {
	if (updatedFiles > 0) console.log(`Rewrote ${ updatedInterpolations } template interpolation spacing boundaries across ${ updatedFiles } files.`)
	process.exit(0)
}

if (diagnostics.length > 0) {
	console.error('Template interpolations must use `${ expression }` spacing.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column } ${ diagnostic.message }`)
	}
	process.exit(1)
}

import process from 'node:process'
import ts from 'typescript'

const filePatterns = ['app/ts/**/*.ts', 'app/ts/**/*.tsx']
const allowedFiles = new Set([
	'app/ts/utils/caughtErrors.ts',
	'app/ts/utils/requests.ts',
])
const rawFetchErrorMessages = new Set([
	'Failed to fetch',
	'NetworkError when attempting to fetch resource',
	'The user aborted a request.',
	'Fetch request timed out.',
	'Fetch request aborted.',
])

type Diagnostic = { file: string, line: number, column: number, text: string }

function scriptKindForPath(path: string) {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

function collectDiagnostics(path: string, sourceText: string) {
	if (allowedFiles.has(path)) return []
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
	const diagnostics: Diagnostic[] = []

	const visit = (node: ts.Node) => {
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && rawFetchErrorMessages.has(node.text)) {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
			diagnostics.push({ file: path, line: line + 1, column: character + 1, text: node.getText(sourceFile) })
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return diagnostics
}

const filePaths = new Set<string>()
for (const pattern of filePatterns) {
	for await (const path of new Bun.Glob(pattern).scan('.')) {
		filePaths.add(path)
	}
}

const diagnostics: Diagnostic[] = []
for (const path of [...filePaths].sort()) {
	const sourceText = await Bun.file(path).text()
	diagnostics.push(...collectDiagnostics(path, sourceText))
}

if (diagnostics.length > 0) {
	console.error('Raw browser fetch error messages must stay in app/ts/utils/caughtErrors.ts or app/ts/utils/requests.ts.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

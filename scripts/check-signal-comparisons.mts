import process from 'node:process'
import { dirname, relative } from 'node:path'
import ts from 'typescript'

type Diagnostic = {
	file: string
	line: number
	column: number
	text: string
}

const formatHost: ts.FormatDiagnosticsHost = {
	getCanonicalFileName: (fileName) => fileName,
	getCurrentDirectory: process.cwd,
	getNewLine: () => ts.sys.newLine,
}

const isEqualityOperator = (kind: ts.SyntaxKind) => {
	switch (kind) {
		case ts.SyntaxKind.EqualsEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsToken:
		case ts.SyntaxKind.EqualsEqualsEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsEqualsToken:
			return true
		default:
			return false
	}
}

const isNullishExpression = (node: ts.Expression) => (
	node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined')
)

const isNullishType = (type: ts.Type) => (
	(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
)

const isPreactSignalDeclaration = (declaration: ts.Declaration) => {
	const fileName = declaration.getSourceFile().fileName.replaceAll('\\', '/')
	return fileName.includes('/@preact/signals/') || fileName.includes('/@preact/signals-core/')
}

const isPreactSignalType = (type: ts.Type): boolean => {
	if (type.isUnion()) {
		if (type.types.some(isNullishType)) return false
		return type.types.some(isPreactSignalType)
	}

	const valueProperty = type.getProperty('value')
	if (valueProperty === undefined) return false

	const declarations = valueProperty.getDeclarations()
	return declarations !== undefined && declarations.some(isPreactSignalDeclaration)
}

const expressionText = (sourceFile: ts.SourceFile, node: ts.Node) => {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
	const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line
	if (start === end) return node.getText(sourceFile)
	return sourceFile.text.split('\n')[start]?.trim() ?? node.getText(sourceFile)
}

const collectSignalComparisonDiagnostics = (sourceFile: ts.SourceFile, checker: ts.TypeChecker) => {
	const diagnostics: Diagnostic[] = []

	const visit = (node: ts.Node) => {
		if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind)) {
			const signalExpression =
				isNullishExpression(node.left) && isPreactSignalType(checker.getTypeAtLocation(node.right))
					? node.right
					: isNullishExpression(node.right) && isPreactSignalType(checker.getTypeAtLocation(node.left))
						? node.left
						: undefined

			if (signalExpression !== undefined) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(signalExpression.getStart(sourceFile))
				diagnostics.push({
					file: relative(process.cwd(), sourceFile.fileName),
					line: line + 1,
					column: character + 1,
					text: expressionText(sourceFile, node),
				})
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return diagnostics
}

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json')
if (configPath === undefined) {
	console.error('Unable to find tsconfig.json.')
	process.exit(1)
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error !== undefined) {
	console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], formatHost))
	process.exit(1)
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath), undefined, configPath)
if (parsedConfig.errors.length > 0) {
	console.error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, formatHost))
	process.exit(1)
}

const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const checker = program.getTypeChecker()
const diagnostics = program.getSourceFiles()
	.filter((sourceFile) => !sourceFile.isDeclarationFile && relative(process.cwd(), sourceFile.fileName).replaceAll('\\', '/').startsWith('app/ts/'))
	.flatMap((sourceFile) => collectSignalComparisonDiagnostics(sourceFile, checker))

if (diagnostics.length > 0) {
	console.error('Signal wrappers must not be compared directly to undefined or null. Compare the signal value instead.')
	for (const diagnostic of diagnostics) {
		console.error(`${ diagnostic.file }:${ diagnostic.line }:${ diagnostic.column }: ${ diagnostic.text }`)
	}
	process.exit(1)
}

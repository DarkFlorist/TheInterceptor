import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

// A module another module loads at runtime, with the names it takes from it, or the whole module when it loads it for its side effects, as a namespace or dynamically.
export type RuntimeDependency = { readonly module: string, readonly names: readonly string[] | 'whole module' }

function resolveRelativeModule(importingFile: string, specifier: string) {
	if (!specifier.startsWith('.')) return undefined
	const withoutExtension = path.join(path.dirname(importingFile), specifier).replace(/\.js$/u, '')
	return ['.ts', '.tsx'].map((extension) => `${ withoutExtension }${ extension }`).find((candidate) => fs.existsSync(candidate))
}

// The names a module takes through import or export specifiers, under the exported name; type-only specifiers are erased at runtime.
const getRuntimeSpecifierNames = (specifiers: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]) => specifiers.filter((specifier) => !specifier.isTypeOnly).map((specifier) => (specifier.propertyName ?? specifier.name).text)

function getRuntimeDependencyNames(statement: ts.Statement): readonly string[] | 'whole module' | undefined {
	if (ts.isImportDeclaration(statement)) {
		const importClause = statement.importClause
		if (importClause === undefined) return 'whole module'
		if (importClause.isTypeOnly) return undefined
		if (importClause.namedBindings !== undefined && ts.isNamespaceImport(importClause.namedBindings)) return 'whole module'
		const names = [...importClause.name === undefined ? [] : ['default'], ...importClause.namedBindings === undefined ? [] : getRuntimeSpecifierNames(importClause.namedBindings.elements)]
		return names.length === 0 ? undefined : names
	}
	if (ts.isExportDeclaration(statement)) {
		if (statement.isTypeOnly) return undefined
		if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) return 'whole module'
		const names = getRuntimeSpecifierNames(statement.exportClause.elements)
		return names.length === 0 ? undefined : names
	}
	return undefined
}

// Static imports, runtime re-exports and dynamic imports with a literal specifier; type-only imports and re-exports carry no runtime dependency.
export function getRuntimeDependencies(file: string): readonly RuntimeDependency[] {
	const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const dependencies: RuntimeDependency[] = []
	const addDependency = (specifier: string, names: readonly string[] | 'whole module') => {
		const module = resolveRelativeModule(file, specifier)
		if (module !== undefined) dependencies.push({ module, names })
	}
	for (const statement of sourceFile.statements) {
		if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue
		const names = getRuntimeDependencyNames(statement)
		if (names !== undefined) addDependency(statement.moduleSpecifier.text, names)
	}
	const visitDynamicImports = (node: ts.Node) => {
		const [specifier] = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments : []
		if (specifier !== undefined && ts.isStringLiteralLike(specifier)) addDependency(specifier.text, 'whole module')
		ts.forEachChild(node, visitDynamicImports)
	}
	visitDynamicImports(sourceFile)
	return dependencies
}

// Every module the entrypoints load at runtime, including the entrypoints.
export function getRuntimeModulesReachableFrom(entrypoints: readonly string[]) {
	const reached = new Set<string>()
	const pending = [...entrypoints]
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || reached.has(file)) continue
		reached.add(file)
		pending.push(...getRuntimeDependencies(file).map((dependency) => dependency.module))
	}
	return reached
}

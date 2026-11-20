import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as path from 'node:path'
import ts from 'typescript'

const sourceRoot = new URL('../../app/ts/', import.meta.url).pathname

const sourceFiles: string[] = []
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceRoot })) sourceFiles.push(file)
sourceFiles.sort()

const isTypeOnlyImport = (statement: ts.ImportDeclaration) => {
	const importClause = statement.importClause
	if (importClause === undefined) return false
	if (importClause.isTypeOnly) return true
	if (importClause.name !== undefined) return false
	const bindings = importClause.namedBindings
	return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
}

const isTypeOnlyExport = (statement: ts.ExportDeclaration) => {
	if (statement.isTypeOnly) return true
	const clause = statement.exportClause
	return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
}

// Only static imports that survive compilation take part in module evaluation order; type-only imports are erased and dynamic imports are lazy.
function getRuntimeRelativeImportSpecifiers(file: string, source: string) {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const specifiers: string[] = []
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && !isTypeOnlyImport(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
		if (ts.isExportDeclaration(statement) && !isTypeOnlyExport(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
	}
	return specifiers.filter((specifier) => specifier.startsWith('.'))
}

function resolveSourceModule(importer: string, specifier: string) {
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
	const withoutExtension = resolved.replace(/\.js$/u, '')
	return [`${ withoutExtension }.ts`, `${ withoutExtension }.tsx`].find((candidate) => sourceFiles.includes(candidate))
}

const importGraph = new Map<string, readonly string[]>()
for (const file of sourceFiles) {
	const source = await Bun.file(path.join(sourceRoot, file)).text()
	const imports = getRuntimeRelativeImportSpecifiers(file, source)
		.map((specifier) => resolveSourceModule(file, specifier))
		.filter((module): module is string => module !== undefined)
	importGraph.set(file, imports)
}

// Tarjan's algorithm: every strongly connected component with more than one module, or a module importing itself, is an import cycle.
function findImportCycles(graph: ReadonlyMap<string, readonly string[]>) {
	let nextIndex = 0
	const indexes = new Map<string, number>()
	const lowLinks = new Map<string, number>()
	const stack: string[] = []
	const onStack = new Set<string>()
	const cycles: string[][] = []
	const visit = (module: string) => {
		indexes.set(module, nextIndex)
		lowLinks.set(module, nextIndex)
		nextIndex++
		stack.push(module)
		onStack.add(module)
		for (const dependency of graph.get(module) ?? []) {
			if (!indexes.has(dependency)) {
				visit(dependency)
				lowLinks.set(module, Math.min(lowLinks.get(module) ?? 0, lowLinks.get(dependency) ?? 0))
			} else if (onStack.has(dependency)) {
				lowLinks.set(module, Math.min(lowLinks.get(module) ?? 0, indexes.get(dependency) ?? 0))
			}
		}
		if (lowLinks.get(module) !== indexes.get(module)) return
		const component: string[] = []
		let member: string | undefined
		do {
			member = stack.pop()
			if (member === undefined) break
			onStack.delete(member)
			component.push(member)
		} while (member !== module)
		if (component.length > 1 || (graph.get(module) ?? []).includes(module)) cycles.push(component.sort())
	}
	for (const module of graph.keys()) if (!indexes.has(module)) visit(module)
	return cycles
}

function getTransitiveRuntimeImports(entry: string) {
	const visited = new Set<string>()
	const pending = [entry]
	while (pending.length > 0) {
		const module = pending.pop()
		if (module === undefined || visited.has(module)) continue
		visited.add(module)
		pending.push(...(importGraph.get(module) ?? []))
	}
	visited.delete(entry)
	return [...visited]
}

test('the import graph covers the extension sources', () => {
	assert.ok(importGraph.size > 100)
	assert.ok((importGraph.get('background/background.ts') ?? []).includes('background/messageSending.ts'))
})

test('the cycle finder reports mutual and self imports', () => {
	assert.deepEqual(findImportCycles(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['c.ts']], ['d.ts', ['a.ts']]])), [['a.ts', 'b.ts'], ['c.ts']])
})

test('type-only imports are not runtime dependencies', () => {
	assert.deepEqual(getRuntimeRelativeImportSpecifiers('example.ts', [
		'import type { A } from \'./typeOnly.js\'',
		'import { type B } from \'./inlineTypeOnly.js\'',
		'export type { C } from \'./typeOnlyExport.js\'',
		'import { type D, value } from \'./mixed.js\'',
		'import \'./sideEffect.js\'',
		'export { E } from \'./reexport.js\'',
	].join('\n')), ['./mixed.js', './sideEffect.js', './reexport.js'])
})

test('extension modules have no import cycles', () => {
	const cycles = findImportCycles(importGraph)
	assert.deepEqual(cycles, [], `Import cycles found:\n${ cycles.map((cycle) => cycle.join(' <-> ')).join('\n') }`)
})

test('the unexpected-error reporter does not load background modules', () => {
	const backgroundImports = getTransitiveRuntimeImports('utils/errors.ts').filter((module) => module.startsWith('background/'))
	assert.deepEqual(backgroundImports, [])
})

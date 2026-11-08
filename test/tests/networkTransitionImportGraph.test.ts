import * as assert from 'node:assert'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { test } from 'bun:test'
import * as ts from 'typescript'

const sourceRoot = new URL('../../app/ts/', import.meta.url).pathname
const backgroundModule = (name: string) => resolve(sourceRoot, 'background', `${ name }.ts`)
const networkTransition = backgroundModule('networkTransition')
const networkTransitionLock = backgroundModule('networkTransitionLock')
const popupVisualisationUpdater = backgroundModule('popupVisualisationUpdater')
const popupSimulationRefreshQueue = backgroundModule('popupSimulationRefreshQueue')

const resolveRelativeImport = (importer: string, specifier: string) => {
	if (!specifier.startsWith('.')) return undefined
	const withoutExtension = resolve(dirname(importer), specifier).replace(/\.js$/u, '')
	return ['.ts', '.tsx'].map((extension) => `${ withoutExtension }${ extension }`).find((candidate) => existsSync(candidate))
}

// Type-only imports are erased, so only imports that load a module at runtime can form a cycle.
const loadsModuleAtRuntime = (statement: ts.Statement): statement is (ts.ImportDeclaration | ts.ExportDeclaration) & { readonly moduleSpecifier: ts.StringLiteral } => {
	if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
	if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false
	const clause = statement.importClause
	if (clause === undefined) return true
	if (clause.isTypeOnly) return false
	const bindings = clause.namedBindings
	const importsOnlyTypes = clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
	return !importsOnlyTypes
}

const readRuntimeImports = async (file: string) => {
	const sourceFile = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.ESNext, false)
	return sourceFile.statements
		.filter(loadsModuleAtRuntime)
		.map((statement) => resolveRelativeImport(file, statement.moduleSpecifier.text))
		.filter((imported) => imported !== undefined)
}

// Every module a file names in an import or export, including type-only ones, which leave no runtime edge but still say which module depends on which.
const readAllImports = async (file: string) => {
	const sourceFile = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.ESNext, false)
	return sourceFile.statements
		.filter((statement): statement is (ts.ImportDeclaration | ts.ExportDeclaration) & { readonly moduleSpecifier: ts.StringLiteral } => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier))
		.map((statement) => resolveRelativeImport(file, statement.moduleSpecifier.text))
		.filter((imported) => imported !== undefined)
}

// The import graph of every app module reachable from the given modules.
const readImportGraph = async (entryModules: readonly string[], readImports: (file: string) => Promise<readonly string[]>) => {
	const graph = new Map<string, readonly string[]>()
	const pending = [...entryModules]
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (graph.has(file)) continue
		const imports = await readImports(file)
		graph.set(file, imports)
		pending.push(...imports)
	}
	return graph
}

// The shortest import chain that leads from the module back to itself, or undefined if the module lies on no cycle.
const findImportCycle = (graph: ReadonlyMap<string, readonly string[]>, module: string) => {
	const reachedFrom = new Map<string, string>()
	const queue: string[] = []
	for (const imported of graph.get(module) ?? []) {
		if (!reachedFrom.has(imported)) reachedFrom.set(imported, module)
		queue.push(imported)
	}
	for (let index = 0; index < queue.length; index++) {
		const current = queue[index]
		if (current === undefined || current === module) break
		for (const imported of graph.get(current) ?? []) {
			if (reachedFrom.has(imported)) continue
			reachedFrom.set(imported, current)
			queue.push(imported)
		}
	}
	if (!reachedFrom.has(module)) return undefined
	const cycle = [module]
	for (let current = reachedFrom.get(module); current !== undefined && current !== module; current = reachedFrom.get(current)) cycle.unshift(current)
	return [module, ...cycle].map((file) => relative(sourceRoot, file))
}

test('network transitions and the popup visualisation layer do not import each other', async () => {
	const graph = await readImportGraph([networkTransition, networkTransitionLock, popupVisualisationUpdater, popupSimulationRefreshQueue], readRuntimeImports)
	const modulesBelowTransitions = [popupVisualisationUpdater, popupSimulationRefreshQueue, networkTransitionLock]
	// The transition module publishes failed visualisations, queues popup refreshes and runs in the lock; this also shows that the graph resolves its imports.
	for (const module of modulesBelowTransitions) assert.ok(graph.get(networkTransition)?.includes(module), `networkTransition.ts imports ${ relative(sourceRoot, module) }`)
	// The visualisation layer reads network state through the lock module, so no import chain leads from these modules back to the transition module.
	for (const module of [networkTransition, ...modulesBelowTransitions]) {
		const cycle = findImportCycle(graph, module)
		assert.equal(cycle, undefined, `runtime import cycle: ${ cycle?.join(' -> ') }`)
	}
})

test('the lock module defines the reads, and depends on none of the modules that consume them', async () => {
	const simulationUpdating = backgroundModule('simulationUpdating')
	const graph = await readImportGraph([networkTransitionLock], readAllImports)
	// Also through type-only imports, so that a value import added later along the same edge cannot form a load-order cycle.
	const cycle = findImportCycle(graph, networkTransitionLock)
	assert.equal(cycle, undefined, `import cycle, counting type-only imports: ${ cycle?.join(' -> ') }`)
	assert.ok(!graph.has(simulationUpdating), 'networkTransitionLock.ts depends on simulationUpdating.ts')
	assert.ok((await readAllImports(simulationUpdating)).includes(networkTransitionLock))
})

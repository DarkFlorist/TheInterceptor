import * as assert from 'assert'
import { describe, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as ts from 'typescript'

const repositoryRoot = path.join(import.meta.dir, '..', '..')
const appRoot = path.join(repositoryRoot, 'app')
const settingsModule = path.join(appRoot, 'ts', 'background', 'settings.ts')

// Settings exports that never write the active network. Page contexts run their own copy of settings.ts, whose network write counts the background's freshness checks never see, so only the background may write the active network.
const settingsExportsAllowedInPageContexts = new Set(['getActiveRpcNetworkWithoutRepair', 'getDefaultBlockExplorer', 'getMakeCurrentAddressRich', 'getUseTabsInsteadOfPopup', 'networkPriceSources'])

// A module another module loads at runtime, with the names it takes from it, or the whole module when it loads it for its side effects, as a namespace or dynamically.
type RuntimeDependency = { readonly module: string, readonly names: readonly string[] | 'whole module' }

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
function getRuntimeDependencies(file: string): readonly RuntimeDependency[] {
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

// Walks every module the entrypoints load at runtime and lists each import of the settings module that is not allowed there.
function findDisallowedSettingsImports(entrypoints: readonly string[], settings: string, allowedNames: ReadonlySet<string>, relativeTo: string) {
	const visited = new Set<string>()
	const pending = [...entrypoints]
	const disallowed: string[] = []
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || visited.has(file)) continue
		visited.add(file)
		for (const dependency of getRuntimeDependencies(file)) {
			pending.push(dependency.module)
			if (dependency.module !== settings) continue
			const names = dependency.names === 'whole module' ? ['the whole module'] : dependency.names.filter((name) => !allowedNames.has(name))
			for (const name of names) disallowed.push(`${ path.relative(relativeTo, file) } imports ${ name }`)
		}
	}
	return { disallowed, reached: visited }
}

// Every runtime entrypoint the bundler builds, except the background, runs in a page context: an extension page such as the popup, or a content or inpage script on a website. The bundler builds app/js from app/ts and app/inpage/js from app/inpage/ts.
function getPageContextEntrypoints(bundlerSource: string, applicationRoot: string) {
	const runtimeEntrypoints = /const runtimeEntrypointPaths = \[([\s\S]*?)\]/u.exec(bundlerSource)?.[1]
	if (runtimeEntrypoints === undefined) throw new Error('The bundler runtime entrypoint list was not found')
	return [...runtimeEntrypoints.matchAll(/path\.join\(appDirectory, ([^)]*)\)/gu)]
		.map((match) => (match[1] ?? '').split(',').map((part) => part.trim().replace(/^'|'$/gu, '')))
		.map((parts) => parts[0] === 'inpage' && parts[1] === 'js'
			? path.join(applicationRoot, 'inpage', 'ts', ...parts.slice(2))
			: path.join(applicationRoot, 'ts', ...parts.slice(1)))
		.map((entrypoint) => entrypoint.replace(/\.js$/u, '.ts'))
		.filter((entrypoint) => entrypoint !== path.join(applicationRoot, 'ts', 'backgroundServiceWorker.ts') && !entrypoint.startsWith(path.join(applicationRoot, 'ts', 'background') + path.sep))
}

function getSourceFiles(directory: string): readonly string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) return getSourceFiles(entryPath)
		return /\.tsx?$/u.test(entry.name) ? [entryPath] : []
	})
}

describe('page contexts and the active network', () => {
	test('page contexts never import a settings read or write that can write the active network', () => {
		const entrypoints = getPageContextEntrypoints(fs.readFileSync(path.join(repositoryRoot, 'build', 'bundler.mts'), 'utf8'), appRoot)
		assert.deepEqual(entrypoints.filter((entrypoint) => !fs.existsSync(entrypoint)), [])
		for (const expected of [path.join(appRoot, 'ts', 'popup.ts'), path.join(appRoot, 'inpage', 'ts', 'listenContentScript.ts')]) assert.ok(entrypoints.includes(expected), expected)
		const { disallowed, reached } = findDisallowedSettingsImports(entrypoints, settingsModule, settingsExportsAllowedInPageContexts, repositoryRoot)
		assert.ok(reached.has(settingsModule), 'The page bundles are expected to reach settings.ts')
		assert.deepEqual(disallowed, [])
	})

	// The freshness check of readActiveNetworkSnapshot counts only the network writes made through settings.ts, so no other module may put the active network in a storage write; storageUtils.ts only declares the stored key.
	test('only settings.ts writes the active network to storage', () => {
		const writersOfTheActiveNetwork = [...getSourceFiles(path.join(appRoot, 'ts')), ...getSourceFiles(path.join(appRoot, 'inpage', 'ts'))]
			.filter((file) => file !== settingsModule && file !== path.join(appRoot, 'ts', 'utils', 'storageUtils.ts'))
			.filter((file) => {
				const source = fs.readFileSync(file, 'utf8')
				return /browserStorageLocalSet|storage\.local\.set/u.test(source) && /\bactiveRpcNetwork\s*[:,}]/u.test(source)
			})
			.map((file) => path.relative(repositoryRoot, file))
		assert.deepEqual(writersOfTheActiveNetwork, [])
	})
})

describe('page context settings import walker', () => {
	// Writes a small module graph to a temporary application root and runs the walker from its page entrypoints, with fixtureSettings standing in for settings.ts.
	function findDisallowedImportsInFixture(files: Readonly<Record<string, string>>, bundlerEntrypoints: readonly string[]) {
		const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-page-context-walker-'))
		try {
			for (const [file, source] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(fixtureRoot, file)), { recursive: true })
				fs.writeFileSync(path.join(fixtureRoot, file), source)
			}
			const bundlerSource = `const runtimeEntrypointPaths = [\n${ bundlerEntrypoints.map((entrypoint) => `\tpath.join(appDirectory, ${ entrypoint }),`).join('\n') }\n]`
			const entrypoints = getPageContextEntrypoints(bundlerSource, fixtureRoot)
			return findDisallowedSettingsImports(entrypoints, path.join(fixtureRoot, 'ts', 'background', 'fixtureSettings.ts'), new Set(['allowedRead']), fixtureRoot).disallowed
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true })
		}
	}

	const fixtureSettings = { 'ts/background/fixtureSettings.ts': 'export const allowedRead = () => 1\nexport const writingRead = () => 2\nexport type ReadResult = number\n' }

	test('follows runtime re-exports to a disallowed settings import', () => {
		const disallowed = findDisallowedImportsInFixture({
			...fixtureSettings,
			'ts/popup.ts': 'import { named } from \'./utils/namedBarrel.js\'\nimport { starred } from \'./utils/starBarrel.js\'\nimport { namespaced } from \'./utils/namespaceBarrel.js\'\nimport { reexportedRead } from \'./utils/settingsBarrel.js\'\nnamed(); starred(); namespaced.namespaced(); reexportedRead()\n',
			'ts/utils/namedBarrel.ts': 'export { named } from \'./named.js\'\n',
			'ts/utils/named.ts': 'import { writingRead } from \'../background/fixtureSettings.js\'\nexport const named = () => writingRead()\n',
			'ts/utils/starBarrel.ts': 'export * from \'./starred.js\'\n',
			'ts/utils/starred.ts': 'import { writingRead } from \'../background/fixtureSettings.js\'\nexport const starred = () => writingRead()\n',
			'ts/utils/namespaceBarrel.ts': 'export * as namespaced from \'./namespaced.js\'\n',
			'ts/utils/namespaced.ts': 'import { writingRead } from \'../background/fixtureSettings.js\'\nexport const namespaced = () => writingRead()\n',
			'ts/utils/settingsBarrel.ts': 'export { allowedRead, writingRead as reexportedRead } from \'../background/fixtureSettings.js\'\n',
		}, ['\'js\', \'popup.js\''])
		assert.deepEqual([...disallowed].sort(), [
			'ts/utils/named.ts imports writingRead',
			'ts/utils/namespaced.ts imports writingRead',
			'ts/utils/settingsBarrel.ts imports writingRead',
			'ts/utils/starred.ts imports writingRead',
		])
	})

	test('checks content and inpage script entrypoints, but not the background', () => {
		const disallowed = findDisallowedImportsInFixture({
			...fixtureSettings,
			'ts/backgroundServiceWorker.ts': 'import { writingRead } from \'./background/fixtureSettings.js\'\nwritingRead()\n',
			'ts/background/background-startup.ts': 'import { writingRead } from \'./fixtureSettings.js\'\nwritingRead()\n',
			'inpage/ts/listenContentScript.ts': 'import { writingRead } from \'../../ts/background/fixtureSettings.js\'\nwritingRead()\n',
			'inpage/ts/document_start.ts': 'void import(\'../../ts/background/fixtureSettings.js\')\n',
		}, ['\'js\', \'backgroundServiceWorker.js\'', '\'js\', \'background\', \'background-startup.js\'', '\'inpage\', \'js\', \'listenContentScript.js\'', '\'inpage\', \'js\', \'document_start.js\''])
		assert.deepEqual([...disallowed].sort(), [
			'inpage/ts/document_start.ts imports the whole module',
			'inpage/ts/listenContentScript.ts imports writingRead',
		])
	})

	test('ignores type-only imports and re-exports, and the modules only they reach', () => {
		const disallowed = findDisallowedImportsInFixture({
			...fixtureSettings,
			'ts/popup.ts': 'import type { ReadResult } from \'./background/fixtureSettings.js\'\nimport { type ReadResult as Result, allowedRead } from \'./background/fixtureSettings.js\'\nimport type { TypeOnlyHelper } from \'./utils/typeOnlyHelper.js\'\nexport type { ReadResult as ExportedResult } from \'./background/fixtureSettings.js\'\nexport { type ReadResult as AlsoExportedResult } from \'./background/fixtureSettings.js\'\nexport const read: () => ReadResult | Result | TypeOnlyHelper = allowedRead\n',
			'ts/utils/typeOnlyHelper.ts': 'import { writingRead } from \'../background/fixtureSettings.js\'\nexport type TypeOnlyHelper = ReturnType<typeof writingRead>\n',
		}, ['\'js\', \'popup.js\''])
		assert.deepEqual(disallowed, [])
	})
})

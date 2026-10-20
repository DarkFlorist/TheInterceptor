import * as assert from 'assert'
import { test } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'

const repositoryRoot = path.join(import.meta.dir, '..', '..')
const sourceRoot = path.join(repositoryRoot, 'app', 'ts')
const settingsModule = path.join(sourceRoot, 'background', 'settings.ts')

// Settings exports that never write the active network. Page contexts run their own copy of settings.ts, whose network write counts the background's freshness checks never see, so only the background may write the active network.
const settingsExportsAllowedInPageContexts = new Set(['getActiveRpcNetworkWithoutRepair', 'getDefaultBlockExplorer', 'getMakeCurrentAddressRich', 'networkPriceSources'])

type ModuleImport = { readonly target: string, readonly names: readonly string[] | 'whole module' }

function resolveSourceImport(importingFile: string, specifier: string) {
	const withoutExtension = path.join(path.dirname(importingFile), specifier).replace(/\.js$/u, '')
	return ['.ts', '.tsx'].map((extension) => `${ withoutExtension }${ extension }`).find((candidate) => fs.existsSync(candidate))
}

// The runtime imports of a module: type-only imports are erased, and dynamic imports or namespace imports load the whole module.
function getRuntimeImports(file: string): readonly ModuleImport[] {
	const source = fs.readFileSync(file, 'utf8')
	const imports: ModuleImport[] = []
	for (const match of source.matchAll(/^\s*import\s+(?!type\b)([^'"]*?)\s+from\s+['"](\.[^'"]+)['"]/gmu)) {
		const [, clause = '', specifier = ''] = match
		const target = resolveSourceImport(file, specifier)
		if (target === undefined) continue
		const namedBindings = /\{([^}]*)\}/u.exec(clause)?.[1]
		const otherBindings = clause.replace(/\{[^}]*\}/u, '').replace(/,/gu, '').trim()
		if (namedBindings === undefined || otherBindings !== '') {
			imports.push({ target, names: 'whole module' })
			continue
		}
		const names = namedBindings.split(',').map((name) => name.trim()).filter((name) => name !== '' && !name.startsWith('type '))
		if (names.length > 0) imports.push({ target, names: names.map((name) => name.split(/\s+as\s+/u)[0] ?? name) })
	}
	for (const match of source.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/gmu)) {
		const target = resolveSourceImport(file, match[1] ?? match[2] ?? '')
		if (target !== undefined) imports.push({ target, names: 'whole module' })
	}
	return imports
}

// Every runtime entrypoint the bundler builds, except the background, runs in a page context such as a popup or a confirmation window.
function getPageContextEntrypoints() {
	const bundler = fs.readFileSync(path.join(repositoryRoot, 'build', 'bundler.mts'), 'utf8')
	const runtimeEntrypoints = /const runtimeEntrypointPaths = \[([\s\S]*?)\]/u.exec(bundler)?.[1]
	if (runtimeEntrypoints === undefined) throw new Error('The bundler runtime entrypoint list was not found')
	return [...runtimeEntrypoints.matchAll(/path\.join\(appDirectory, 'js', ([^)]*)\)/gu)]
		.map((match) => (match[1] ?? '').split(',').map((part) => part.trim().replace(/^'|'$/gu, '')))
		.filter((parts) => parts[0] !== 'background' && parts[0] !== 'backgroundServiceWorker.js')
		.map((parts) => path.join(sourceRoot, ...parts).replace(/\.js$/u, '.ts'))
}

test('page contexts never import a settings read or write that can write the active network', () => {
	const entrypoints = getPageContextEntrypoints()
	assert.ok(entrypoints.some((entrypoint) => entrypoint.endsWith(path.join('app', 'ts', 'popup.ts'))))
	const reachable = new Set<string>()
	const pending = entrypoints.filter((entrypoint) => fs.existsSync(entrypoint))
	const disallowedSettingsImports: string[] = []
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || reachable.has(file)) continue
		reachable.add(file)
		for (const moduleImport of getRuntimeImports(file)) {
			pending.push(moduleImport.target)
			if (moduleImport.target !== settingsModule) continue
			const names = moduleImport.names === 'whole module' ? ['the whole module'] : moduleImport.names.filter((name) => !settingsExportsAllowedInPageContexts.has(name))
			for (const name of names) disallowedSettingsImports.push(`${ path.relative(repositoryRoot, file) } imports ${ name }`)
		}
	}
	assert.ok(reachable.has(settingsModule), 'The page bundles are expected to reach settings.ts')
	assert.deepEqual(disallowedSettingsImports, [])
})

function getSourceFiles(directory: string): readonly string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) return getSourceFiles(entryPath)
		return /\.tsx?$/u.test(entry.name) ? [entryPath] : []
	})
}

// The freshness check of readActiveNetworkSnapshot counts only the network writes made through settings.ts, so no other module may put the active network in a storage write; storageUtils.ts only declares the stored key.
test('only settings.ts writes the active network to storage', () => {
	const writersOfTheActiveNetwork = getSourceFiles(sourceRoot)
		.filter((file) => file !== settingsModule && file !== path.join(sourceRoot, 'utils', 'storageUtils.ts'))
		.filter((file) => {
			const source = fs.readFileSync(file, 'utf8')
			return /browserStorageLocalSet|storage\.local\.set/u.test(source) && /\bactiveRpcNetwork\s*[:,}]/u.test(source)
		})
		.map((file) => path.relative(repositoryRoot, file))
	assert.deepEqual(writersOfTheActiveNetwork, [])
})

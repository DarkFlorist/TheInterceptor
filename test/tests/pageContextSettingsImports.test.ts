import * as assert from 'assert'
import { describe, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getRuntimeDependencies } from './runtimeDependencyGraph.js'

const repositoryRoot = path.join(import.meta.dir, '..', '..')
const appRoot = path.join(repositoryRoot, 'app')
const settingsModule = path.join(appRoot, 'ts', 'background', 'settings.ts')
const storageUtilsModule = path.join(appRoot, 'ts', 'utils', 'storageUtils.ts')

// Settings exports that never write the active network. Page contexts run their own copy of settings.ts and storageUtils.ts, whose network write counts the background's freshness checks never see, so only the background may write the active network.
const settingsExportsAllowedInPageContexts = new Set(['getActiveRpcNetworkWithoutRepair', 'getDefaultBlockExplorer', 'getMakeCurrentAddressRich', 'getUseTabsInsteadOfPopup', 'networkPriceSources'])

// Which names page-reachable code may import from each module that can write the active network.
type ImportRules = ReadonlyMap<string, (name: string, importer: string) => boolean>
const pageContextImportRules: ImportRules = new Map([
	[settingsModule, (name: string) => settingsExportsAllowedInPageContexts.has(name)],
	// settings.ts writes the network itself, but only from exports that the settings rule above keeps out of page code.
	[storageUtilsModule, (name: string, importer: string) => importer === settingsModule || name !== 'browserStorageLocalSetActiveNetwork'],
])

// Walks every module the entrypoints load at runtime and lists each import that the rules do not allow there.
function findDisallowedImports(entrypoints: readonly string[], rules: ImportRules, relativeTo: string) {
	const visited = new Set<string>()
	const pending = [...entrypoints]
	const disallowed: string[] = []
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || visited.has(file)) continue
		visited.add(file)
		for (const dependency of getRuntimeDependencies(file)) {
			pending.push(dependency.module)
			const isAllowed = rules.get(dependency.module)
			if (isAllowed === undefined) continue
			const names = dependency.names === 'whole module' ? ['the whole module'] : dependency.names.filter((name) => !isAllowed(name, file))
			for (const name of names) disallowed.push(`${ path.relative(relativeTo, file) } imports ${ name } from ${ path.basename(dependency.module) }`)
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
	test('page contexts never import a settings read or storage write that can write the active network', () => {
		const entrypoints = getPageContextEntrypoints(fs.readFileSync(path.join(repositoryRoot, 'build', 'bundler.mts'), 'utf8'), appRoot)
		assert.deepEqual(entrypoints.filter((entrypoint) => !fs.existsSync(entrypoint)), [])
		for (const expected of [path.join(appRoot, 'ts', 'popup.ts'), path.join(appRoot, 'inpage', 'ts', 'listenContentScript.ts')]) assert.ok(entrypoints.includes(expected), expected)
		const { disallowed, reached } = findDisallowedImports(entrypoints, pageContextImportRules, repositoryRoot)
		assert.ok(reached.has(settingsModule), 'The page bundles are expected to reach settings.ts')
		assert.deepEqual(disallowed, [])
	})

	// The freshness check of readActiveNetworkSnapshot counts only the network writes made through browserStorageLocalSetActiveNetwork, the only typed setter that accepts the key and which only settings.ts calls; this also catches writes that bypass the typed setters, such as a raw browser.storage.local.set.
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
			return findDisallowedImports(entrypoints, new Map([[path.join(fixtureRoot, 'ts', 'background', 'fixtureSettings.ts'), (name: string) => name === 'allowedRead']]), fixtureRoot).disallowed
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
			'ts/utils/named.ts imports writingRead from fixtureSettings.ts',
			'ts/utils/namespaced.ts imports writingRead from fixtureSettings.ts',
			'ts/utils/settingsBarrel.ts imports writingRead from fixtureSettings.ts',
			'ts/utils/starred.ts imports writingRead from fixtureSettings.ts',
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
			'inpage/ts/document_start.ts imports the whole module from fixtureSettings.ts',
			'inpage/ts/listenContentScript.ts imports writingRead from fixtureSettings.ts',
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

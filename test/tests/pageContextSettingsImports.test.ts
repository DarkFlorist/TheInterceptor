import * as assert from 'assert'
import { describe, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { type RawStorageAccess, findUncountedStorageAccess } from './rawStorageAccess.js'
import { getRuntimeDependencies } from './runtimeDependencyGraph.js'

const repositoryRoot = path.join(import.meta.dir, '..', '..')
const appRoot = path.join(repositoryRoot, 'app')
const settingsModule = path.join(appRoot, 'ts', 'background', 'settings.ts')
const activeNetworkStorageModule = path.join(appRoot, 'ts', 'background', 'activeNetworkStorage.ts')
const pageSafeSettingsModule = path.join(appRoot, 'ts', 'background', 'pageSafeSettings.ts')
const storageUtilsModule = path.join(appRoot, 'ts', 'utils', 'storageUtils.ts')

// Which names page-reachable code may import from a module that page contexts must not use freely.
type ImportRules = ReadonlyMap<string, (name: string, importer: string) => boolean>
// Page contexts compile their own copy of every module they import, whose active network write counts the background's freshness checks never see. So no page bundle may reach activeNetworkStorage.ts, which writes and counts the active network, or settings.ts, which writes it through activeNetworkStorage.ts; pages use pageSafeSettings.ts instead.
const pageContextImportRules: ImportRules = new Map([
	[settingsModule, () => false],
	[activeNetworkStorageModule, () => false],
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

const getApplicationSourceFiles = () => [...getSourceFiles(path.join(appRoot, 'ts')), ...getSourceFiles(path.join(appRoot, 'inpage', 'ts'))]

describe('page contexts and the active network', () => {
	test('page contexts never reach the modules that write the active network', () => {
		const entrypoints = getPageContextEntrypoints(fs.readFileSync(path.join(repositoryRoot, 'build', 'bundler.mts'), 'utf8'), appRoot)
		assert.deepEqual(entrypoints.filter((entrypoint) => !fs.existsSync(entrypoint)), [])
		for (const expected of [path.join(appRoot, 'ts', 'popup.ts'), path.join(appRoot, 'inpage', 'ts', 'listenContentScript.ts')]) assert.ok(entrypoints.includes(expected), expected)
		const { disallowed, reached } = findDisallowedImports(entrypoints, pageContextImportRules, repositoryRoot)
		assert.ok(reached.has(pageSafeSettingsModule), 'The page bundles are expected to read settings through pageSafeSettings.ts')
		assert.deepEqual(disallowed, [])
		assert.deepEqual([settingsModule, activeNetworkStorageModule].filter((module) => reached.has(module)).map((module) => path.relative(repositoryRoot, module)), [])
	})

	// A raw browser.storage write bypasses the typed setters, and with them the active network write counts in activeNetworkStorage.ts, whatever key it writes. Of the modules that write browser storage directly, storageUtils.ts writes only through its typed setters, whose types exclude the active network, and names the key only in its storage schema and those types; largeStateStore.ts writes only its LargeStateStorageKey values and their marker keys, and storageVariables.ts removes only tabState_ keys. A new direct writer has to be listed here after checking that it can never write the active network.
	test('browser storage is written directly only by the counted writer and reviewed writers of other keys', () => {
		const rawStorageAccess: ReadonlyMap<string, RawStorageAccess> = new Map([
			[activeNetworkStorageModule, 'counted writer'],
			[storageUtilsModule, 'typed writer'],
			[path.join(appRoot, 'ts', 'utils', 'largeStateStore.ts'), 'reviewed writer of other keys'],
			[path.join(appRoot, 'ts', 'background', 'storageVariables.ts'), 'reviewed writer of other keys'],
		])
		// iconHandler.ts passes browser to runTabIconUpdate only as the scope of its locks, which createScopedKeyedSerialExecutor in semaphore.ts uses solely as a WeakMap key.
		const identityKeyCallees = new Set(['runTabIconUpdate'])
		const violations = getApplicationSourceFiles().flatMap((file) => findUncountedStorageAccess(file, fs.readFileSync(file, 'utf8'), rawStorageAccess.get(file) ?? 'reads only', identityKeyCallees).map((violation) => `${ path.relative(repositoryRoot, file) } ${ violation }`))
		assert.deepEqual(violations, [])
	})
})

describe('uncounted browser storage access checker', () => {
	const check = (source: string, access: RawStorageAccess) => findUncountedStorageAccess('fixture.ts', source, access)

	test('allows direct reads, change listeners and storage types everywhere', () => {
		assert.deepEqual(check('const stored = await browser.storage.local.get(\'activeRpcNetwork\')\nbrowser.storage.onChanged.addListener(listener)\nbrowser.storage.onChanged.removeListener(listener)\ntype Change = browser.storage.StorageChange\nawait browser.tabs.query({})\n', 'reads only'), [])
	})

	test('allows direct writes of other keys in a reviewed writer, but not one that names the active network', () => {
		assert.deepEqual(check('await browser.storage.local.set({ openedPageV2: page })\nawait browser.storage.local.remove(key)\n', 'reviewed writer of other keys'), [])
		assert.deepEqual(check('await browser.storage.local.set({ activeRpcNetwork: network })\n', 'reviewed writer of other keys'), ['names activeRpcNetwork although it writes browser storage directly, outside the counted writer'])
	})

	test('rejects clear even in a reviewed writer, because it removes the active network without naming it', () => {
		assert.deepEqual(check('await browser.storage.local.clear()\n', 'reviewed writer of other keys'), ['line 1: uses browser.storage other than through a direct call of local.get, local.set, local.remove or onChanged listeners'])
		assert.deepEqual(check('await chrome.storage.local.clear()\n', 'counted writer'), ['line 1: uses chrome.storage other than through a direct call of local.get, local.set, local.remove or onChanged listeners'])
	})

	test('rejects direct writes outside the listed writers', () => {
		assert.deepEqual(check('await browser.storage.local.set({ activeRpcNetwork: network })\nawait globalThis.browser.storage.local.remove(\'activeRpcNetwork\')\n', 'reads only'), [
			'line 1: calls browser.storage.local.set directly outside the listed storage writers',
			'line 2: calls browser.storage.local.remove directly outside the listed storage writers',
		])
	})

	test('rejects aliases of the storage API, which could write without a visible set call', () => {
		const storageAliasViolation = 'uses browser.storage other than through a direct call of local.get, local.set, local.remove or onChanged listeners'
		assert.deepEqual(check('const local = browser.storage.local\nawait local.set({ activeRpcNetwork: network })\n', 'reads only'), [`line 1: ${ storageAliasViolation }`])
		assert.deepEqual(check('const { local } = browser.storage\nconst setter = browser.storage.local.set\nawait browser.storage.local[\'set\']({ activeRpcNetwork: network })\nawait (browser.storage.local).set({ activeRpcNetwork: network })\n', 'reads only'), [1, 2, 3, 4].map((line) => `line ${ line }: ${ storageAliasViolation }`))
		assert.deepEqual(check('const api = browser\nconst { storage } = chrome\nawait browser[\'storage\'].local.clear()\n', 'counted writer'), [
			'line 1: uses browser other than through a property access, which could hide a storage write',
			'line 2: uses chrome other than through a property access, which could hide a storage write',
			'line 3: uses browser other than through a property access, which could hide a storage write',
		])
	})

	test('rejects runtime import aliases of the storage API, but not erased qualified names', () => {
		const importAliasViolation = 'aliases browser through an import declaration, which could hide a storage write'
		const everyAccess: readonly RawStorageAccess[] = ['reads only', 'reviewed writer of other keys', 'typed writer', 'counted writer']
		for (const access of everyAccess) assert.deepEqual(check('import local = browser.storage.local\nexport const clear = async () => await local.clear()\nexport const write = async () => await local.set({ openedPageV2: page })\n', access), [`line 1: ${ importAliasViolation }`])
		assert.deepEqual(check('export import storage = browser.storage\nawait storage.local.set({ activeRpcNetwork: network })\nawait storage.local.clear()\n', 'counted writer'), [`line 1: ${ importAliasViolation }`])
		assert.deepEqual(check('import api = browser\nawait api.storage.local.clear()\n', 'reads only'), ['line 1: uses browser other than through a property access, which could hide a storage write'])
		assert.deepEqual(check('import type StorageArea = browser.storage.StorageArea\ntype Local = typeof browser.storage.local\nconst change: browser.storage.StorageChange | undefined = undefined\n', 'reads only'), [])
	})

	test('accepts browser itself only as the first argument of a callee reviewed to use it as an identity key', () => {
		const identityKeyCallees = new Set(['runWithScope'])
		assert.deepEqual(findUncountedStorageAccess('fixture.ts', 'await runWithScope(browser, key, task)\n', 'reads only', identityKeyCallees), [])
		assert.deepEqual(findUncountedStorageAccess('fixture.ts', 'await writeThrough(browser)\nawait runWithScope(key, browser)\n', 'reads only', identityKeyCallees), [
			'line 1: uses browser other than through a property access, which could hide a storage write',
			'line 2: uses browser other than through a property access, which could hide a storage write',
		])
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

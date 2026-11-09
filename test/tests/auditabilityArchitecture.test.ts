import * as assert from 'node:assert'
import { test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'
import * as simulationFacade from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import * as simulationPersonalSigning from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import * as simulationTransactionSigning from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { getPopupMessageDomain, isPopupMessageMethod, popupMessageProtocol } from '../../app/ts/types/popupMessageProtocol.js'

const popupHandlerRegistrySources = [
	Bun.file(new URL('../../app/ts/background/popupMessageDispatcher.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/addressBook.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/settings.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/websiteAccess.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/safe.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupSettingsCommands.ts', import.meta.url)),
]
const safeConfirmationResolverSource = await Bun.file(new URL('../../app/ts/background/safeConfirmationResolver.ts', import.meta.url)).text()
const safeConfirmationPersistenceSource = await Bun.file(new URL('../../app/ts/background/safeConfirmationPersistence.ts', import.meta.url)).text()
const safeTransactionConfirmationSource = await Bun.file(new URL('../../app/ts/background/safeTransactionConfirmation.ts', import.meta.url)).text()
const safeSignerSelectionRefreshSource = await Bun.file(new URL('../../app/ts/background/safeSignerSelectionRefresh.ts', import.meta.url)).text()
const safePendingFlowSource = await Bun.file(new URL('../../app/ts/safe/safePendingFlow.ts', import.meta.url)).text()
const confirmTransactionSource = await Bun.file(new URL('../../app/ts/background/windows/confirmTransaction.ts', import.meta.url)).text()
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const confirmTransactionPageSource = await Bun.file(new URL('../../app/ts/components/pages/ConfirmTransaction.tsx', import.meta.url)).text()
const safeAppsCompatibilityCoordinatorSource = await Bun.file(new URL('../../app/ts/background/safeAppsCompatibilityCoordinator.ts', import.meta.url)).text()
const accessManagementSource = await Bun.file(new URL('../../app/ts/background/accessManagement.ts', import.meta.url)).text()
const backgroundUtilsSource = await Bun.file(new URL('../../app/ts/background/backgroundUtils.ts', import.meta.url)).text()
const websiteActiveAddressSource = await Bun.file(new URL('../../app/ts/background/websiteActiveAddress.ts', import.meta.url)).text()
const websiteTabConnectionsSource = await Bun.file(new URL('../../app/ts/background/websiteTabConnections.ts', import.meta.url)).text()
const refreshPopupSimulationSource = popupMessageHandlersSource.slice(
	popupMessageHandlersSource.indexOf('export async function refreshPopupConfirmTransactionSimulation'),
	popupMessageHandlersSource.indexOf('export async function popupChangeActiveRpc'),
)

const hasDuplicatedSafePendingFlowDiscriminant = (source: string) => {
	const aliases = new Map(Array.from(
		source.matchAll(/^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/gmu),
		(match) => [match[1], match[2]] as const,
	))
	const resolveAlias = (identifier: string) => {
		const visited = new Set<string>()
		while (aliases.has(identifier) && !visited.has(identifier)) {
			visited.add(identifier)
			identifier = aliases.get(identifier) ?? identifier
		}
		return identifier
	}
	const normalizedSource = source.replace(/\s+/gu, ' ')
	return [
		/\b([A-Za-z_$][A-Za-z0-9_$]*)\.type === 'Transaction' && ([A-Za-z_$][A-Za-z0-9_$]*)\.safeExecutionOriginalRequestParameters(?: !== undefined|\?\.)/gu,
		/\b([A-Za-z_$][A-Za-z0-9_$]*)\.type === 'SignableMessage' && ([A-Za-z_$][A-Za-z0-9_$]*)\.safeMessageCoSignSnapshot(?: !== undefined|\?\.)/gu,
		/\b([A-Za-z_$][A-Za-z0-9_$]*)\.type === 'Transaction' && ([A-Za-z_$][A-Za-z0-9_$]*)\.safeTransaction(?: !== undefined|\?\.)/gu,
	].some((discriminant) => Array.from(normalizedSource.matchAll(discriminant)).some((match) => {
		const typeOwner = match[1]
		const safeFieldOwner = match[2]
		return typeOwner !== undefined && safeFieldOwner !== undefined && resolveAlias(typeOwner) === resolveAlias(safeFieldOwner)
	}))
}

const hasRawSafeFieldAfterTransactionNarrowing = (source: string) => {
	const normalizedSource = source.replace(/\s+/gu, ' ')
	return /\b([A-Za-z_$][A-Za-z0-9_$]*)\.type !== 'Transaction'.{0,3000}\b\1\.(?:safeExecutionOriginalRequestParameters|safeTransaction)\b/u.test(normalizedSource)
}

const getDeclaredPopupHandlerMethods = async (source: Bun.BunFile) => {
	const contents = await source.text()
	return Array.from(contents.matchAll(/^\s*(popup_[A-Za-z0-9_]+):/gmu), (match) => match[1]).filter((method) => method !== undefined)
}

test('simulation service keeps compatibility exports backed by focused signing modules', () => {
	assert.equal(simulationFacade.mockSignTransaction, simulationTransactionSigning.mockSignTransaction)
	assert.equal(simulationFacade.getSignedTransactionForSimulation, simulationTransactionSigning.getSignedTransactionForSimulation)
	assert.equal(simulationFacade.getMessageHashForPersonalSign, simulationPersonalSigning.getMessageHashForPersonalSign)
	assert.equal(simulationFacade.simulatePersonalSign, simulationPersonalSigning.simulatePersonalSign)
})

test('Safe Apps compatibility lifecycle has a peer-level coordinator', () => {
	assert.match(safeAppsCompatibilityCoordinatorSource, /function createSafeAppsCompatibilityCoordinator/u)
	assert.match(websiteTabConnectionsSource, /from '\.\/websiteLifecycle\.js'/u)
	assert.doesNotMatch(accessManagementSource, /safeAppsCompatibilityCoordinator/u)
	assert.doesNotMatch(websiteTabConnectionsSource, /from '\.\/accessManagement\.js'/u)
	assert.doesNotMatch(accessManagementSource, /function createSafeAppsCompatibilityCoordinator/u)
	assert.match(backgroundUtilsSource, /export const getWebsiteSocketConnection/u)
	assert.match(websiteActiveAddressSource, /export async function getWebsiteActiveAddress/u)
	assert.doesNotMatch(safeAppsCompatibilityCoordinatorSource, /function getConnectionDetails|function getActiveAddressForDomain/u)
	assert.doesNotMatch(accessManagementSource, /function getConnectionDetails|function getActiveAddressForDomain/u)
})

test('popup handler registries agree with the protocol domain inventory', () => {
	const expectedRegistryDomains = [
		{ source: popupHandlerRegistrySources[1], domains: new Set(['address-book', 'navigation']) },
		{ source: popupHandlerRegistrySources[2], domains: new Set(['settings', 'navigation']) },
		{ source: popupHandlerRegistrySources[3], domains: new Set(['website-access', 'navigation']) },
		{ source: popupHandlerRegistrySources[4], domains: new Set(['safe']) },
		{ source: popupHandlerRegistrySources[5], domains: new Set(['home', 'settings', 'simulation']) },
	]
	return Promise.all(expectedRegistryDomains.map(async ({ source, domains }) => {
		if (source === undefined) throw new Error('Popup handler registry source is missing')
		const methods = await getDeclaredPopupHandlerMethods(source)
		assert.notEqual(methods.length, 0)
		for (const method of methods) {
			assert.equal(isPopupMessageMethod(method), true, `${ method } is missing from the popup protocol`)
			if (!isPopupMessageMethod(method)) continue
			assert.equal(domains.has(getPopupMessageDomain(method)), true, `${ method } is assigned to the wrong domain`)
		}
	}))
})

test('each popup method has exactly one handler owner', async () => {
	const declaredMethods = (await Promise.all(popupHandlerRegistrySources.map(getDeclaredPopupHandlerMethods))).flat()
	const duplicateMethods = declaredMethods.filter((method, index) => declaredMethods.indexOf(method) !== index)
	assert.deepEqual(duplicateMethods, [])
	assert.equal(new Set(declaredMethods).size, Object.keys(popupMessageProtocol).length)
	for (const method of Object.keys(popupMessageProtocol)) assert.equal(declaredMethods.includes(method), true, `${ method } has no handler owner`)
})

test('historical popup wire spellings are explicit protocol exceptions', () => {
	assert.equal(popupMessageProtocol.popup_ChangeSettings.legacyWireName, true)
	assert.equal(popupMessageProtocol.popup_import_settings.legacyWireName, true)
	assert.equal(popupMessageProtocol.popup_UnexpectedErrorOccured.legacyWireName, true)
	assert.equal('legacyWireName' in popupMessageProtocol.popup_confirmDialog, false)
})

test('popup method guards reject inherited object keys', () => {
	assert.equal(isPopupMessageMethod('toString'), false)
	assert.equal(isPopupMessageMethod('__proto__'), false)
})

const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const parseAppSource = async (path: string) => ts.createSourceFile(path, await Bun.file(join(appSourceDirectory, path)).text(), ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const repositoryRoot = new URL('../../', import.meta.url).pathname

// The project's compiler options, so the import guard resolves modules exactly as tsc does.
function readProjectCompilerOptions() {
	const configPath = join(repositoryRoot, 'tsconfig.json')
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
	if (configFile.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
	return ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot, undefined, configPath).options
}

type ModuleSourceHost = Pick<ts.ModuleResolutionHost, 'fileExists' | 'readFile'>

// Every module a source file depends on, type-only ones included: import and export declarations, inline import('...') types, and dynamic import() calls.
function collectModuleSpecifiers(sourceFile: ts.SourceFile) {
	const specifiers: string[] = []
	const visit = (node: ts.Node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text)
		const firstArgument = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
		if (firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)) specifiers.push(firstArgument.text)
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return specifiers
}

// The project modules reachable from the entry files, each with the project modules it depends on, resolved by TypeScript's own resolver. Library modules are left out.
function buildImportGraph(entryPaths: readonly string[], host: ModuleSourceHost, compilerOptions: ts.CompilerOptions) {
	const graph = new Map<string, ReadonlySet<string>>()
	const pending = [...entryPaths]
	for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
		if (graph.has(path)) continue
		const text = host.readFile(path)
		if (text === undefined) throw new Error(`Cannot read ${ path }`)
		const imported = new Set<string>()
		for (const specifier of collectModuleSpecifiers(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS))) {
			const resolved = ts.resolveModuleName(specifier, path, compilerOptions, host).resolvedModule
			if (resolved === undefined || resolved.isExternalLibraryImport === true) continue
			imported.add(resolved.resolvedFileName)
			pending.push(resolved.resolvedFileName)
		}
		graph.set(path, imported)
	}
	return graph
}

const findReachableModules = (graph: ReadonlyMap<string, ReadonlySet<string>>, start: string) => {
	const reached = new Set<string>()
	const pending = [start]
	for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
		for (const imported of graph.get(path) ?? []) {
			if (reached.has(imported)) continue
			reached.add(imported)
			pending.push(imported)
		}
	}
	return reached
}

// Fails when each module reaches the other through the import graph.
function assertNoImportCycle(graph: ReadonlyMap<string, ReadonlySet<string>>, first: string, second: string) {
	if (findReachableModules(graph, first).has(second) && findReachableModules(graph, second).has(first)) throw new Error(`Import cycle between ${ first } and ${ second }`)
}

test('the pending-request storage, decision and outbox modules import in one direction only, so none of them has an import cycle', () => {
	const [storageVariables, pendingRequestDecisions, pendingTerminalReplies] = ['background/storageVariables.ts', 'background/pendingRequestDecisions.ts', 'background/pendingTerminalReplies.ts'].map((path) => join(appSourceDirectory, path))
	if (storageVariables === undefined || pendingRequestDecisions === undefined || pendingTerminalReplies === undefined) throw new Error('Expected three module paths')
	const graph = buildImportGraph([storageVariables, pendingRequestDecisions, pendingTerminalReplies], ts.sys, readProjectCompilerOptions())
	// The outbox decides through the decision module, which writes through the storage module.
	assert.equal(graph.get(pendingTerminalReplies)?.has(pendingRequestDecisions), true)
	assert.equal(graph.get(pendingRequestDecisions)?.has(storageVariables), true)
	// The storage module stays a leaf of the three, and the decision module never reaches the outbox, not even through a type.
	const reachedFromStorage = findReachableModules(graph, storageVariables)
	assert.equal(reachedFromStorage.has(pendingRequestDecisions) || reachedFromStorage.has(pendingTerminalReplies), false)
	assert.equal(findReachableModules(graph, pendingRequestDecisions).has(pendingTerminalReplies), false)
	assertNoImportCycle(graph, storageVariables, pendingRequestDecisions)
	assertNoImportCycle(graph, storageVariables, pendingTerminalReplies)
	assertNoImportCycle(graph, pendingRequestDecisions, pendingTerminalReplies)
})

// In-memory modules where outbox.ts imports storage.ts, and storage.ts reaches back in each way the guard has to see.
const importCycleFixtures = {
	'an extensionless import': { '/fixture/storage.ts': `import type { Write } from './outbox'\nexport type Stored = Write` },
	'an index import': { '/fixture/storage.ts': `import type { Write } from './outbox/index.js'\nexport type Stored = Write`, '/fixture/outbox/index.ts': `import { stored } from '../storage.js'\nexport type Write = typeof stored` },
	'a directory import that resolves to its index': { '/fixture/storage.ts': `import type { Write } from './outbox'\nexport type Stored = Write`, '/fixture/outbox/index.ts': `import { stored } from '../storage.js'\nexport type Write = typeof stored` },
	'an inline import() type': { '/fixture/storage.ts': `export type Stored = import('./outbox.js').Write` },
	'a transitive import': { '/fixture/storage.ts': `import type { Write } from './middle.js'\nexport type Stored = Write`, '/fixture/middle.ts': `export type { Write } from './outbox.js'` },
} as const

const importFixtureHost = (files: Readonly<Record<string, string>>): ModuleSourceHost => ({
	fileExists: (path) => path in files,
	readFile: (path) => files[path],
})

for (const [kind, files] of Object.entries(importCycleFixtures)) {
	test(`the import cycle guard sees ${ kind }`, () => {
		// Fixtures with an outbox directory get no outbox.ts beside it, so './outbox' can only resolve to the directory's index.
		const outbox = '/fixture/outbox/index.ts' in files ? '/fixture/outbox/index.ts' : '/fixture/outbox.ts'
		const modules = outbox === '/fixture/outbox.ts' ? { '/fixture/outbox.ts': `import { stored } from './storage.js'\nexport type Write = typeof stored`, ...files } : files
		const graph = buildImportGraph(['/fixture/storage.ts', outbox], importFixtureHost(modules), readProjectCompilerOptions())
		assert.throws(() => assertNoImportCycle(graph, '/fixture/storage.ts', outbox), /Import cycle/u)
	})
}

test('the import cycle guard passes modules that import in one direction only', () => {
	const modules = { '/fixture/outbox.ts': `import { stored } from './storage.js'\nexport type Write = typeof stored`, '/fixture/storage.ts': 'export const stored = 1' }
	const graph = buildImportGraph(['/fixture/storage.ts', '/fixture/outbox.ts'], importFixtureHost(modules), readProjectCompilerOptions())
	assertNoImportCycle(graph, '/fixture/storage.ts', '/fixture/outbox.ts')
})

// Building a PendingTerminalRepliesWrite needs this symbol's value, so limiting who names it limits who can build one. Comments do not count.
test('only the outbox module and its declaration name the pending terminal replies write brand', async () => {
	const filesNamingBrand = new Set<string>()
	for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan(appSourceDirectory)) {
		const visit = (node: ts.Node) => {
			if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'pendingTerminalRepliesWriteBrand') filesNamingBrand.add(path)
			ts.forEachChild(node, visit)
		}
		visit(await parseAppSource(path))
	}
	assert.deepEqual([...filesNamingBrand].sort(), ['background/pendingTerminalReplies.ts', 'utils/storageUtils.ts'])
})

// The background owns the confirmation queue and sends it over the message protocol, so the window neither reads browser storage nor imports the background's storage module.
test('the confirmation page gets its queue over the message protocol, never from storage', () => {
	assert.doesNotMatch(confirmTransactionPageSource, /browser\.storage|storageVariables|pendingTransactionsAndMessages|storageUtils/u)
	assert.match(confirmTransactionPageSource, /popup_requestConfirmTransactionQueue/u)
})

test('Safe signer refresh persistence is isolated from confirmation resolution', () => {
	assert.match(safeSignerSelectionRefreshSource, /export async function refreshAndPersistSafeSignerSelection[\s\S]*?updatePendingTransactionOrMessage/u)
	assert.match(confirmTransactionSource, /refreshAndPersistSafeSignerSelection\(/u)
	assert.doesNotMatch(safeConfirmationResolverSource, /function shouldRefreshSafeSignerSelection/u)
	assert.doesNotMatch(safeConfirmationResolverSource, /function mergeSafeSignerSelectionRefresh/u)
	assert.doesNotMatch(safeSignerSelectionRefreshSource, /JSON\.stringify/u)
	assert.doesNotMatch(confirmTransactionSource, /function shouldRefreshSafeSignerSelection/u)
	assert.doesNotMatch(confirmTransactionSource, /function mergeSafeSignerSelectionRefresh/u)
	assert.doesNotMatch(confirmTransactionSource, /function persistSafeSignerSelectionRefresh/u)
})

test('Safe pending flow discrimination has one owner', () => {
	assert.match(safePendingFlowSource, /kind: 'directExecution'/u)
	assert.match(safePendingFlowSource, /kind: 'messageCoSign'/u)
	assert.match(safePendingFlowSource, /kind: 'proposal'/u)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(`
		candidate.type === 'Transaction'
			&& candidate.safeTransaction?.safeAddress !== undefined
	`), true)
	assert.equal(hasRawSafeFieldAfterTransactionNarrowing(`
		if (candidate.type !== 'Transaction') return
		use(candidate.safeTransaction)
	`), true)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(`
		const alias = candidate
		candidate.type === 'Transaction'
			&& alias.safeTransaction !== undefined
	`), true)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(safeConfirmationResolverSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(safeConfirmationPersistenceSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(safeTransactionConfirmationSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(safeSignerSelectionRefreshSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(confirmTransactionSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(popupMessageHandlersSource), false)
	assert.equal(hasDuplicatedSafePendingFlowDiscriminant(confirmTransactionPageSource), false)
	assert.equal(hasRawSafeFieldAfterTransactionNarrowing(refreshPopupSimulationSource), false)
	assert.doesNotMatch(confirmTransactionPageSource, /currentPendingTransactionOrSignableMessage\.value\.(?:safeExecutionOriginalRequestParameters|safeTransaction)/u)
})


test('website lifecycle dependencies are explicit callbacks rather than a global event bus', async () => {
	const lifecycleSource = await Bun.file(new URL('../../app/ts/background/websiteLifecycle.ts', import.meta.url)).text()
	const startupSource = await Bun.file(new URL('../../app/ts/background/background-startup.ts', import.meta.url)).text()
	assert.doesNotMatch(lifecycleSource, /new (?:WeakMap|Map|Set)|subscribeWebsiteLifecycle|publishWebsiteLifecycle/u)
	assert.match(accessManagementSource, /notifyWebsiteLifecycle\(websiteTabConnections\.lifecycle\?\.accessReconciled\)/u)
	assert.match(startupSource, /lifecycle: safeAppsCompatibility\.lifecycle/u)
})

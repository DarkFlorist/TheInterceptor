import * as assert from 'node:assert'
import { test } from 'bun:test'
import { dirname, join, normalize } from 'node:path'
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

// Every module of the extension source with the modules it imports or re-exports from, type-only ones included, as paths relative to app/ts.
async function readAppImportGraph() {
	const paths = new Set<string>()
	for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan(appSourceDirectory)) paths.add(path)
	const resolve = (path: string) => paths.has(path) ? path : path.replace(/\.ts$/u, '.tsx')
	const graph = new Map<string, ReadonlySet<string>>()
	for (const path of paths) {
		const imported = new Set<string>()
		for (const statement of (await parseAppSource(path)).statements) {
			if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
			if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue
			imported.add(resolve(normalize(join(dirname(path), statement.moduleSpecifier.text)).replace(/\.js$/u, '.ts')))
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

test('storageVariables.ts imports nothing from pendingTerminalReplies.ts, not even a type, so the two modules have no import cycle', async () => {
	const graph = await readAppImportGraph()
	assert.equal(graph.get('background/pendingTerminalReplies.ts')?.has('background/storageVariables.ts'), true)
	assert.equal(graph.get('background/storageVariables.ts')?.has('background/pendingTerminalReplies.ts'), false)
	assert.equal(findReachableModules(graph, 'background/storageVariables.ts').has('background/pendingTerminalReplies.ts'), false)
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

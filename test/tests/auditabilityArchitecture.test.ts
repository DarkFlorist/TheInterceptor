import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as simulationFacade from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import * as simulationPersonalSigning from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import * as simulationTransactionSigning from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { getPopupMessageDomain, isPopupMessageMethod, popupMessageProtocol } from '../../app/ts/types/popupMessageProtocol.js'

const popupMessageHandlerRegistriesDirectory = new URL('../../app/ts/background/popupMessageHandlerRegistries/', import.meta.url)
const popupMessageHandlersDirectory = new URL('../../app/ts/background/popupMessageHandlers/', import.meta.url)
const popupHandlerRegistryFileNames: string[] = []
for await (const file of new Bun.Glob('*.ts').scan({ cwd: popupMessageHandlerRegistriesDirectory.pathname })) popupHandlerRegistryFileNames.push(file)
const popupHandlerRegistrySources = [
	Bun.file(new URL('../../app/ts/background/popupMessageDispatcher.ts', import.meta.url)),
	...popupHandlerRegistryFileNames.map((file) => Bun.file(new URL(file, popupMessageHandlerRegistriesDirectory))),
]
const popupMessageHandlerFileNames: string[] = []
for await (const file of new Bun.Glob('*.ts').scan({ cwd: popupMessageHandlersDirectory.pathname })) popupMessageHandlerFileNames.push(file)
const safeConfirmationResolverSource = await Bun.file(new URL('../../app/ts/background/safeConfirmationResolver.ts', import.meta.url)).text()
const safeConfirmationPersistenceSource = await Bun.file(new URL('../../app/ts/background/safeConfirmationPersistence.ts', import.meta.url)).text()
const safeTransactionConfirmationSource = await Bun.file(new URL('../../app/ts/background/safeTransactionConfirmation.ts', import.meta.url)).text()
const safeSignerSelectionRefreshSource = await Bun.file(new URL('../../app/ts/background/safeSignerSelectionRefresh.ts', import.meta.url)).text()
const safePendingFlowSource = await Bun.file(new URL('../../app/ts/safe/safePendingFlow.ts', import.meta.url)).text()
const confirmTransactionSource = await Bun.file(new URL('../../app/ts/background/windows/confirmTransaction.ts', import.meta.url)).text()
const popupMessageHandlersSource = (await Promise.all(popupMessageHandlerFileNames.map(async (file) => await Bun.file(new URL(file, popupMessageHandlersDirectory)).text()))).join('\n')
const confirmationPopupMessageHandlersSource = await Bun.file(new URL('confirmation.ts', popupMessageHandlersDirectory)).text()
const confirmTransactionPageSource = await Bun.file(new URL('../../app/ts/components/pages/ConfirmTransaction.tsx', import.meta.url)).text()
const safeAppsCompatibilityCoordinatorSource = await Bun.file(new URL('../../app/ts/background/safeAppsCompatibilityCoordinator.ts', import.meta.url)).text()
const accessManagementSource = await Bun.file(new URL('../../app/ts/background/accessManagement.ts', import.meta.url)).text()
const backgroundUtilsSource = await Bun.file(new URL('../../app/ts/background/backgroundUtils.ts', import.meta.url)).text()
const websiteActiveAddressSource = await Bun.file(new URL('../../app/ts/background/websiteActiveAddress.ts', import.meta.url)).text()
const websiteTabConnectionsSource = await Bun.file(new URL('../../app/ts/background/websiteTabConnections.ts', import.meta.url)).text()
const refreshPopupSimulationSource = confirmationPopupMessageHandlersSource.slice(
	confirmationPopupMessageHandlersSource.indexOf('export async function refreshPopupConfirmTransactionSimulation'),
)

const hasDuplicatedSafePendingFlowDiscriminant = (source: string) => {
	const aliases = new Map(Array.from(
		source.matchAll(/^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/gmu),
		(match) => [match[1], match[2]] as const,
	))
	const resolveAlias = (identifier: string) => {
		const visited = new Set<string>()
		let resolvedIdentifier = identifier
		while (aliases.has(resolvedIdentifier) && !visited.has(resolvedIdentifier)) {
			visited.add(resolvedIdentifier)
			resolvedIdentifier = aliases.get(resolvedIdentifier) ?? resolvedIdentifier
		}
		return resolvedIdentifier
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
	// Each registry owns one protocol domain; page openers may sit with the domain whose page they open, and settings commands share one admission coordinator.
	const expectedRegistryDomains: Record<string, ReadonlySet<string>> = {
		'addressBook.ts': new Set(['address-book', 'navigation']),
		'confirmation.ts': new Set(['confirmation']),
		'diagnostics.ts': new Set(['diagnostics']),
		'home.ts': new Set(['home']),
		'navigation.ts': new Set(['navigation']),
		'safe.ts': new Set(['safe']),
		'settings.ts': new Set(['settings', 'navigation']),
		'settingsCommands.ts': new Set(['home', 'settings', 'simulation']),
		'simulation.ts': new Set(['simulation']),
		'websiteAccess.ts': new Set(['website-access', 'navigation']),
	}
	assert.deepEqual([...popupHandlerRegistryFileNames].sort(), Object.keys(expectedRegistryDomains).sort())
	return Promise.all(popupHandlerRegistryFileNames.map(async (file) => {
		const domains = expectedRegistryDomains[file]
		if (domains === undefined) throw new Error(`Popup handler registry ${ file } has no expected domains`)
		const methods = await getDeclaredPopupHandlerMethods(Bun.file(new URL(file, popupMessageHandlerRegistriesDirectory)))
		assert.notEqual(methods.length, 0)
		for (const method of methods) {
			assert.equal(isPopupMessageMethod(method), true, `${ method } is missing from the popup protocol`)
			if (!isPopupMessageMethod(method)) continue
			assert.equal(domains.has(getPopupMessageDomain(method)), true, `${ method } is assigned to the wrong domain`)
		}
	}))
})

test('the dispatcher only combines domain registries', async () => {
	const dispatcherSource = await Bun.file(new URL('../../app/ts/background/popupMessageDispatcher.ts', import.meta.url)).text()
	assert.deepEqual(await getDeclaredPopupHandlerMethods(Bun.file(new URL('../../app/ts/background/popupMessageDispatcher.ts', import.meta.url))), [])
	for (const file of popupHandlerRegistryFileNames) assert.match(dispatcherSource, new RegExp(`from '\\./popupMessageHandlerRegistries/${ file.replace('.ts', '\\.js') }'`, 'u'))
})

test('each popup handler implementation file is wired by the registry of the same domain', async () => {
	assert.equal(await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).exists(), false)
	for (const file of popupMessageHandlerFileNames) assert.ok(popupHandlerRegistryFileNames.includes(file), `popupMessageHandlers/${ file } has no popupMessageHandlerRegistries/${ file }`)
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

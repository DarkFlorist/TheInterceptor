import * as assert from 'node:assert'
import { test } from 'bun:test'
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
const confirmationRunStorageSource = await Bun.file(new URL('../../app/ts/background/confirmationRunStorage.ts', import.meta.url)).text()
const confirmationRelabelSource = await Bun.file(new URL('../../app/ts/background/confirmationRelabel.ts', import.meta.url)).text()
const addressBookChangePublicationSource = await Bun.file(new URL('../../app/ts/background/addressBookChangePublication.ts', import.meta.url)).text()
const simulationUpdatingSource = await Bun.file(new URL('../../app/ts/background/simulationUpdating.ts', import.meta.url)).text()
const storedRunVisualisationSource = await Bun.file(new URL('../../app/ts/background/storedRunVisualisation.ts', import.meta.url)).text()
const metadataUtilsSource = await Bun.file(new URL('../../app/ts/background/metadataUtils.ts', import.meta.url)).text()
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

test('Safe signer refresh persistence is isolated from confirmation resolution', () => {
	// A refreshed direct Safe execution carries a new confirmation run, so the refresh persists through the confirmation-run writer.
	assert.match(safeSignerSelectionRefreshSource, /export async function refreshAndPersistSafeSignerSelection[\s\S]*?simulateAndStoreConfirmationRun\(/u)
	assert.match(confirmTransactionSource, /refreshAndPersistSafeSignerSelection\(/u)
	assert.doesNotMatch(safeConfirmationResolverSource, /function shouldRefreshSafeSignerSelection/u)
	assert.doesNotMatch(safeConfirmationResolverSource, /function mergeSafeSignerSelectionRefresh/u)
	assert.doesNotMatch(safeSignerSelectionRefreshSource, /JSON\.stringify/u)
	assert.doesNotMatch(confirmTransactionSource, /function shouldRefreshSafeSignerSelection/u)
	assert.doesNotMatch(confirmTransactionSource, /function mergeSafeSignerSelectionRefresh/u)
	assert.doesNotMatch(confirmTransactionSource, /function persistSafeSignerSelectionRefresh/u)
})

test('the simulation and utils layers take the metadata lookup types from types/, not from the background', async () => {
	const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
	const importsLookupTypeFromBackground = /import\s+(?:type\s+)?\{[^}]*\b(?:IdentifyAddress|LookUpEnsName|MetadataLookups)\b[^}]*\}\s+from\s+'[^']*\/background\//u
	const offendingFiles: string[] = []
	for await (const file of new Bun.Glob('{simulation,utils}/**/*.ts').scan({ cwd: appSourceDirectory })) {
		if (importsLookupTypeFromBackground.test(await Bun.file(`${ appSourceDirectory }${ file }`).text())) offendingFiles.push(file)
	}
	assert.deepEqual(offendingFiles, [])
})

test('confirmation runs are stored through the confirmation-run storage, which catches up on address-book changes published during a run', () => {
	// The publish step only counts its change; each run reads the count before its lookups and after it is stored, so no module marks runs from a distance.
	assert.match(addressBookChangePublicationSource, /publishedAddressBookChangeCount \+= 1/u)
	assert.doesNotMatch(addressBookChangePublicationSource, /from '\.\/confirmationRunStorage\.js'/u)
	assert.match(confirmationRunStorageSource, /getPublishedAddressBookChangeCount\(\)[\s\S]*?await simulateAndStore\([\s\S]*?getPublishedAddressBookChangeCount\(\)/u)
	// The re-label does not depend on the storage, so the storage can request it without an import cycle.
	assert.doesNotMatch(confirmationRelabelSource, /from '\.\/confirmationRunStorage\.js'/u)
	// Every workflow that stores a confirmation run depends on the storage, not on the re-label.
	for (const [name, source] of [['windows/confirmTransaction.ts', confirmTransactionSource], ['safeSignerSelectionRefresh.ts', safeSignerSelectionRefreshSource], ['popupMessageHandlers.ts', popupMessageHandlersSource]] as const) {
		assert.doesNotMatch(source, /from '[^']*confirmationRelabel\.js'/u, name)
		assert.match(source, /simulateAndStoreConfirmationRun\(/u, name)
	}
	// Only simulateAndStoreConfirmationRun hands out the writer, and it reads the count before the run's first lookup, so no stored run can skip the catch-up re-label.
	assert.match(confirmationRunStorageSource, /export type StoreConfirmationRun\b/u)
	assert.doesNotMatch(confirmationRunStorageSource, /export (?:const|async function|function) storeConfirmationRun\b/u)
})

test('the stored-data visualisation of a re-label lives apart from live simulation and builds the same typed lookups', () => {
	// simulationUpdating.ts keeps live node-backed simulation; replaying a stored run belongs to storedRunVisualisation.ts.
	assert.doesNotMatch(simulationUpdatingSource, /replayRecordedProtectorChainReads|lookUpMetadataForRelabel|function visualizeStoredRunWithoutNode/u)
	assert.match(storedRunVisualisationSource, /export async function visualizeStoredRunWithoutNode\(/u)
	// The re-label's address fallback is re-label display policy, so it sits with the other stored-run lookups, not in the generic identification of metadataUtils.ts.
	assert.match(storedRunVisualisationSource, /export function lookUpMetadataForRelabel\(/u)
	assert.match(storedRunVisualisationSource, /function getIdentifiedOrBareAddressEntry\(/u)
	assert.doesNotMatch(metadataUtilsSource, /lookUpMetadataForRelabel|getIdentifiedOrBareAddressEntry/u)
	// Both modes build their lookups as VisualisationLookups, so a lookup either one leaves out fails typecheck.
	assert.match(simulationUpdatingSource, /function lookUpVisualisationOnNode\([^)]*\): VisualisationLookups \{/u)
	assert.match(storedRunVisualisationSource, /function lookUpVisualisationFromStoredRun\([^)]*\): VisualisationLookups \{/u)
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

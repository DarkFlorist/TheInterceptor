import type { ExportedSettings, Page } from '../types/exportedSettingsTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { BlockExplorer, RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, type RichListElement, browserStorageLocalGet, browserStorageLocalSafeParse, browserStorageLocalSet, getStartupStorageValueOrDefault, type StartupStorageValues } from '../utils/storageUtils.js'
import { getRpcConfigurationStateWithStorageSnapshot } from './rpcConfigurationStorage.js'
import { getUserAddressBookEntries } from './storageVariables.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'

import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_BLOCK_MANIPULATION, DEFAULT_RPCS } from '../config/defaults.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import type { SigningAddressPreference, SigningAddressPreferences } from '../types/signerTypes.js'
import type { RpcConfigurationState } from './rpcConfigurationStorage.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'

export const defaultActiveAddresses = DEFAULT_ACTIVE_ADDRESSES

export const networkPriceSources = {
	uniswapV2Like: [
		{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2
	],
	uniswapV3Like: [
		{ factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984n, initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' } // Uniswap V3
	]
} as const

export const defaultRpcs = DEFAULT_RPCS

export const defaultSimulationMode = true

const wethForChainId = new Map<string, EthereumAddress>([
	['1', 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n], // Mainnet
	['11155111', 0x105083929bf9bb22c26cb1777ec92661170d4285n], // Sepolia
	['10', 0x4200000000000000000000000000000000000006n], //OP Mainnet
	['8453', 0x4200000000000000000000000000000000000006n], // Base
	['42161', 0x82af49447d8a07e3bd95bd0d56f35241523fbab1n], // Arbitrum
])

export const getDefaultBlockExplorer = (): BlockExplorer => ({ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8' })

export const getWethForChainId = (chainId: bigint) => wethForChainId.get(chainId.toString())

async function getParsedStorageValueOrDefault<Key extends keyof StartupStorageValues>(key: Key, defaultValue: StartupStorageValues[Key]): Promise<StartupStorageValues[Key]> {
	return await getStartupStorageValueOrDefault(await browser.storage.local.get(key), key, defaultValue)
}

const SETTINGS_STORAGE_KEYS = [
	'independentActiveSimulationAddress',
	'activeSigningSafeAddress',
	'openedPageV2',
	'useSignersAddressAsActiveAddress',
	'websiteAccess',
	'simulationMode',
] as const

const getWebsiteAccessFromStorageItems = async (storedItems: Readonly<Record<string, unknown>>) => sanitizeWebsiteAccess(await getStartupStorageValueOrDefault(storedItems, 'websiteAccess', []))

type SettingsStorageFields = Omit<Settings, 'activeRpcNetwork'>

function getStartupSettingsStorageFields(): SettingsStorageFields {
	if (defaultRpcs[0] === undefined || defaultActiveAddresses[0] === undefined) throw new Error('default rpc or default address was missing')
	return {
		activeSimulationAddress: defaultActiveAddresses[0].address,
		activeSigningSafeAddress: undefined,
		openedPage: { page: 'Home' },
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [],
		simulationMode: defaultSimulationMode,
	}
}

// Settings are these stored fields on an active RPC network; this is the only place the two are combined.
const withActiveRpcNetwork = (fields: SettingsStorageFields, activeRpcNetwork: RpcNetwork): Settings => ({
	activeSimulationAddress: fields.activeSimulationAddress,
	activeSigningSafeAddress: fields.activeSigningSafeAddress,
	openedPage: fields.openedPage,
	useSignersAddressAsActiveAddress: fields.useSignersAddressAsActiveAddress,
	websiteAccess: fields.websiteAccess,
	activeRpcNetwork,
	simulationMode: fields.simulationMode,
})

// The single storage-to-settings-fields conversion. Fields missing from `storedItems` take their value from `missingFieldValues`.
async function getSettingsFieldsFromStorageItems(storedItems: Readonly<Record<string, unknown>>, missingFieldValues: SettingsStorageFields = getStartupSettingsStorageFields()): Promise<SettingsStorageFields> {
	const activeSimulationAddressPromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'independentActiveSimulationAddress', missingFieldValues.activeSimulationAddress))
	const activeSigningSafeAddressPromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'activeSigningSafeAddress', missingFieldValues.activeSigningSafeAddress))
	const openedPagePromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'openedPageV2', missingFieldValues.openedPage))
	const useSignersAddressAsActiveAddressPromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'useSignersAddressAsActiveAddress', missingFieldValues.useSignersAddressAsActiveAddress))
	const websiteAccessPromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'websiteAccess', missingFieldValues.websiteAccess).then(sanitizeWebsiteAccess))
	const simulationModePromise = silenceChromeUnCaughtPromise(getStartupStorageValueOrDefault(storedItems, 'simulationMode', missingFieldValues.simulationMode))
	const [activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, simulationMode] = await Promise.all([
		activeSimulationAddressPromise,
		activeSigningSafeAddressPromise,
		openedPagePromise,
		useSignersAddressAsActiveAddressPromise,
		websiteAccessPromise,
		simulationModePromise,
	])
	return { activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, simulationMode }
}

const getSettingsFromStorageItems = async (storedItems: Readonly<Record<string, unknown>>, activeRpcNetwork: RpcNetwork, missingFieldValues?: SettingsStorageFields) => withActiveRpcNetwork(await getSettingsFieldsFromStorageItems(storedItems, missingFieldValues), activeRpcNetwork)

// Website approvals are stored apart from the RPC configuration, so they stay readable while settings are unavailable; `unreadable` keeps the storage error for callers that must propagate it.
export type WebsiteApprovalsSnapshot =
	| { readonly status: 'readable', readonly websiteAccess: WebsiteAccessArray }
	| { readonly status: 'unreadable', readonly error: unknown }

// Settings and the RPC configuration come from one storage read and must travel together through an admitted operation. The snapshot status describes whether the active network could be decoded. Use settingsIfRpcConfigurationReady for decisions that require a usable RPC configuration.
export type SettingsSnapshot =
	| { readonly status: 'active-network-readable', readonly settings: Settings, readonly rpcConfiguration: RpcConfigurationState }
	| { readonly status: 'active-network-unreadable', readonly rpcConfiguration: RpcConfigurationState, readonly websiteApprovals: WebsiteApprovalsSnapshot }

const getStorageReadError = (rpcConfiguration: RpcConfigurationState) => rpcConfiguration.status === 'unavailable' && rpcConfiguration.reason === 'read-failed' ? { error: 'error' in rpcConfiguration ? rpcConfiguration.error : undefined } : undefined

// Decode settings and the RPC selection from the same storage read.
async function readSettingsStorage() {
	const { storedItems, rpcConfiguration } = await getRpcConfigurationStateWithStorageSnapshot(SETTINGS_STORAGE_KEYS)
	return { storedItems, rpcConfiguration, storageReadError: getStorageReadError(rpcConfiguration) }
}

// The persisted settings, available only while the stored RPC configuration has an active RPC network.
export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
	const { storedItems, rpcConfiguration, storageReadError } = await readSettingsStorage()
	const activeRpcNetwork = 'activeRpcNetwork' in rpcConfiguration ? rpcConfiguration.activeRpcNetwork : undefined
	if (activeRpcNetwork !== undefined) return { status: 'active-network-readable', settings: await getSettingsFromStorageItems(storedItems, activeRpcNetwork), rpcConfiguration }
	const websiteApprovals: WebsiteApprovalsSnapshot = storageReadError === undefined
		? { status: 'readable', websiteAccess: await getWebsiteAccessFromStorageItems(storedItems) }
		: { status: 'unreadable', error: storageReadError.error }
	return { status: 'active-network-unreadable', rpcConfiguration, websiteApprovals }
}

// Callers that only apply stored approvals can read them without initializing RPC configuration. Callers granting authority use getSettingsSnapshot so approvals and RPC readiness come from one read. `repairCorrupt` writes no approvals over a corrupt value (a failed write is unreadable); without it a corrupt value reads as no approvals and nothing is written.
export async function getWebsiteApprovalsSnapshot(options: { readonly repairCorrupt: boolean }): Promise<WebsiteApprovalsSnapshot> {
	try {
		if (options.repairCorrupt) return { status: 'readable', websiteAccess: sanitizeWebsiteAccess(await getParsedStorageValueOrDefault('websiteAccess', [])) }
		const { websiteAccess: storedWebsiteAccess } = await browser.storage.local.get('websiteAccess')
		if (storedWebsiteAccess === undefined) return { status: 'readable', websiteAccess: [] }
		return { status: 'readable', websiteAccess: sanitizeWebsiteAccess(browserStorageLocalSafeParse({ websiteAccess: storedWebsiteAccess })?.websiteAccess ?? []) }
	} catch (error: unknown) {
		return { status: 'unreadable', error }
	}
}

// The settings fields, required to be readable: throws the RPC-configuration-unavailable error when the active network itself cannot be read. Readable is all it proves; the RPC entries may still be corrupt, emptied or unwritable. A decision that needs a usable RPC configuration (granting, tab blocking, anything trusting the active chain) uses settingsIfRpcConfigurationReady instead.
export function requireReadableSettings(snapshot: SettingsSnapshot): Settings {
	if (snapshot.status === 'active-network-unreadable') throw createRpcConfigurationUnavailableError()
	return snapshot.settings
}

// RPC editors can repair an unreadable active selection by treating it as absent. Storage/repair failures remain errors rather than being mistaken for an unselected network.
export async function getActiveRpcNetworkForConfigurationEditing(): Promise<RpcNetwork | undefined> {
	const snapshot = await getSettingsSnapshot()
	const configuration = snapshot.rpcConfiguration
	if (configuration.status === 'unavailable' && (configuration.reason === 'read-failed' || configuration.reason === 'write-failed')) throw configuration.error ?? createRpcConfigurationUnavailableError()
	return snapshot.status === 'active-network-readable' ? snapshot.settings.activeRpcNetwork : undefined
}

export const pageStorageWrite = (openedPageV2: Page): StorageWrite => ({ openedPageV2 })
export const setPage = async (page: Page) => await browserStorageLocalSet(pageStorageWrite(page))
export const getPage = async() => (await browserStorageLocalGet('openedPageV2'))?.openedPageV2 ?? { page: 'Home' }

export async function getSigningAddressPreferences() {
	return await getParsedStorageValueOrDefault('signingAddressPreferences', [])
}

export const signingAddressPreferencesStorageWrite = (signingAddressPreferences: SigningAddressPreferences): StorageWrite => ({ signingAddressPreferences })

export async function rememberSigningAddressPreference(preference: SigningAddressPreference) {
	await runSettingsStorageTransaction(async () => {
		const preferences = await getSigningAddressPreferences()
		return { writes: [signingAddressPreferencesStorageWrite([...preferences.filter((existing) => existing.signerAddress !== preference.signerAddress), preference])], result: undefined }
	})
}

export const setMakeCurrentAddressRich = async (makeCurrentAddressRich: boolean) => await browserStorageLocalSet({ makeCurrentAddressRich })
export const getStoredSimulationMode = async () => await getParsedStorageValueOrDefault('simulationMode', defaultSimulationMode)

export const getMakeCurrentAddressRich = async() => await getParsedStorageValueOrDefault('makeCurrentAddressRich', false)

const makeMeRichSettingsSemaphore = new Semaphore(1)

export async function updateMakeCurrentAddressRich(update: (makeCurrentAddressRich: boolean) => boolean) {
	return await makeMeRichSettingsSemaphore.execute(async () => {
		const previous = await getMakeCurrentAddressRich()
		const next = update(previous)
		if (next === previous) return false
		await setMakeCurrentAddressRich(next)
		return true
	})
}

export const setFixedMakeMeRichList = async (fixedAddressRichList: readonly RichListElement[]) => await browserStorageLocalSet({ fixedAddressRichList })
export async function getFixedAddressRichList() { return await getParsedStorageValueOrDefault('fixedAddressRichList', []) }

function toComparableRichListElement(element: RichListElement): RichListElement {
	return {
		address: element.address,
		makingRich: element.makingRich,
		type: element.type,
	}
}

function richListElementsEqual(first: RichListElement, second: RichListElement) {
	const firstValues = Object.values(toComparableRichListElement(first))
	const secondValues = Object.values(toComparableRichListElement(second))
	return firstValues.length === secondValues.length && firstValues.every((value, index) => value === secondValues[index])
}

export async function updateFixedMakeMeRichList(update: (fixedAddressRichList: readonly RichListElement[]) => readonly RichListElement[]) {
	return await makeMeRichSettingsSemaphore.execute(async () => {
		const previous = await getFixedAddressRichList()
		const next = update(previous)
		if (previous.length === next.length && previous.every((element, index) => {
			const nextElement = next[index]
			return nextElement !== undefined && richListElementsEqual(element, nextElement)
		})) return false
		await setFixedMakeMeRichList(next)
		return true
	})
}

export async function trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress: EthereumAddress | undefined) {
	return await updateFixedMakeMeRichList((currentList) => {
		const richList = currentList
			.filter((element) => !(element.type === 'PreviousActiveAddress' && !element.makingRich))
			.map((element) => ({ ...element, type: 'UserAdded' as const }))
		if (previousActiveAddress === undefined || richList.some((element) => element.address === previousActiveAddress)) return richList
		return [...richList, { address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' as const }]
	})
}

export const useSignersAddressAsActiveAddressStorageWrite = (useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined): StorageWrite => ({
	useSignersAddressAsActiveAddress,
	...useSignersAddressAsActiveAddress === true ? { activeSigningAddress: currentSignerAddress } : {}
})

export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined) {
	const storageUpdate = useSignersAddressAsActiveAddressStorageWrite(useSignersAddressAsActiveAddress, currentSignerAddress)
	await browserStorageLocalSet(storageUpdate)
	return storageUpdate

}

export type SimulationModeChanges = {
	readonly simulationMode: boolean
	readonly rpcNetwork?: RpcNetwork
	readonly activeSimulationAddress?: EthereumAddress
	readonly activeSigningAddress?: EthereumAddress
	readonly activeSigningSafeAddress?: EthereumAddress
}

export function simulationModeStorageWrite(changes: SimulationModeChanges): StorageWrite {
	return {
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { activeRpcNetwork: changes.rpcNetwork }: {},
		...'activeSimulationAddress' in changes ? { independentActiveSimulationAddress: changes.activeSimulationAddress } : {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: changes.activeSigningAddress }: {},
		...'activeSigningSafeAddress' in changes ? { activeSigningSafeAddress: changes.activeSigningSafeAddress }: {},
	}
}

export async function changeSimulationMode(changes: SimulationModeChanges): Promise<LocalStorageItems> {
	const storageUpdate = simulationModeStorageWrite(changes)
	await browserStorageLocalSet(storageUpdate)
	return storageUpdate
}

async function getNormalizedWebsiteAccessFromStorage() {
	const rawWebsiteAccess = await getParsedStorageValueOrDefault('websiteAccess', [])
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(rawWebsiteAccess)
	return { rawWebsiteAccess, sanitizedWebsiteAccess }
}

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
}

export const websiteAccessStorageWrite = (websiteAccess: WebsiteAccessArray): StorageWrite => ({ websiteAccess: sanitizeWebsiteAccess(websiteAccess) })

// Returns the stored value before and after the update so rollback transactions can restore only what this update changed.
export async function updateWebsiteAccessWithSnapshots(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	return await runSettingsStorageTransaction(async () => {

		const { rawWebsiteAccess, sanitizedWebsiteAccess } = await getNormalizedWebsiteAccessFromStorage()
		const nextWebsiteAccess = sanitizeWebsiteAccess(updateFunc(sanitizedWebsiteAccess))
		const changed = nextWebsiteAccess !== sanitizedWebsiteAccess || rawWebsiteAccess !== sanitizedWebsiteAccess
		return { writes: changed ? [websiteAccessStorageWrite(nextWebsiteAccess)] : [], result: { previousWebsiteAccess: sanitizedWebsiteAccess, updatedWebsiteAccess: nextWebsiteAccess } }
	})
}

// Last-write-wins: applies the update to the latest stored value; see tryWebsiteAccessRollback in settingsTransactions.ts for the merge-and-restore variant.
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	return (await updateWebsiteAccessWithSnapshots(updateFunc)).updatedWebsiteAccess
}

export async function updateKnownWebsiteMetadata(website: Website) {
	await updateWebsiteAccess((previousWebsiteAccess) => {
		let changed = false
		const nextWebsiteAccess = previousWebsiteAccess.map((entry) => {
			if (entry.website.websiteOrigin !== website.websiteOrigin) return entry
			const mergedWebsite = mergeStoredWebsiteMetadata(entry.website, website)
			if (mergedWebsite === entry.website) return entry
			changed = true
			return { ...entry, website: mergedWebsite }
		})
		return changed ? nextWebsiteAccess : previousWebsiteAccess
	})
}

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.useTabsInsteadOfPopup ?? false
export const useTabsInsteadOfPopupStorageWrite = (useTabsInsteadOfPopup: boolean): StorageWrite => ({ useTabsInsteadOfPopup })
export const setUseTabsInsteadOfPopup = async(useTabsInsteadOfPopup: boolean) => await browserStorageLocalSet(useTabsInsteadOfPopupStorageWrite(useTabsInsteadOfPopup))

export const getMetamaskCompatibilityMode = async() => (await browserStorageLocalGet('metamaskCompatibilityMode'))?.metamaskCompatibilityMode ?? false
export const metamaskCompatibilityModeStorageWrite = (metamaskCompatibilityMode: boolean): StorageWrite => ({ metamaskCompatibilityMode })
export const persistMetamaskCompatibilityMode = async(metamaskCompatibilityMode: boolean) => await browserStorageLocalSet(metamaskCompatibilityModeStorageWrite(metamaskCompatibilityMode))

export const getSafeAppsCompatibilityMode = async() => (await browserStorageLocalGet('safeAppsCompatibilityMode'))?.safeAppsCompatibilityMode ?? false
export const safeAppsCompatibilityModeStorageWrite = (safeAppsCompatibilityMode: boolean): StorageWrite => ({ safeAppsCompatibilityMode })
export const setSafeAppsCompatibilityMode = async(safeAppsCompatibilityMode: boolean) => await browserStorageLocalSet(safeAppsCompatibilityModeStorageWrite(safeAppsCompatibilityMode))

// A backup requires a real selected network. Configuration repair remains available through the RPC editor and import; exporting must never invent an active selection.
export async function exportSettingsAndAddressBook(): Promise<ExportedSettings> {
	const exportDate = (new Date).toISOString().split('T')[0]
	if (exportDate === undefined) throw new Error('Datestring did not contain Date')
	const [settings, signingAddressPreferences] = await Promise.all([getSettingsSnapshot().then(requireReadableSettings), getSigningAddressPreferences()])
	return {
		name: 'InterceptorSettingsAndAddressBook' as const,
		version: '1.6' as const,
		exportedDate: exportDate,
		settings: {
			activeSimulationAddress: settings.activeSimulationAddress,
			activeSigningSafeAddress: settings.activeSigningSafeAddress,
			signingAddressPreferences,
			openedPage: settings.openedPage,
			useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
			websiteAccess: settings.websiteAccess,
			rpcNetwork: settings.activeRpcNetwork,
			simulationMode: settings.simulationMode,
			addressBookEntries: await getUserAddressBookEntries(),
			useTabsInsteadOfPopup: await getUseTabsInsteadOfPopup(),
			metamaskCompatibilityMode: await getMetamaskCompatibilityMode(),
			safeAppsCompatibilityMode: await getSafeAppsCompatibilityMode(),
		}
	}
}

export const setPreSimulationBlockTimeManipulation = async (preSimulationBlockTimeManipulation: BlockTimeManipulation) => await browserStorageLocalSet({ preSimulationBlockTimeManipulation })
export const getPreSimulationBlockTimeManipulation = async() => (await browserStorageLocalGet('preSimulationBlockTimeManipulation'))?.preSimulationBlockTimeManipulation ?? DEFAULT_BLOCK_MANIPULATION

// Use when the operation needs a decoded active network and its boundary handles RPC unavailability. Call getSettingsSnapshot when the operation can continue without an active network.
export async function requireSettingsWithReadableNetwork(): Promise<Settings> {
	return requireReadableSettings(await getSettingsSnapshot())
}

// Comparison fields have no websiteAccess member: absence of authority is represented in the type, never as a fictitious revocation of every approval.
export type ConfigurationComparisonSettings = Omit<Settings, 'websiteAccess'>
const configurationComparisonSettings = ({ websiteAccess: _websiteAccess, ...fields }: Settings): ConfigurationComparisonSettings => fields

// Configuration editors may compare an unavailable selection with the installed dormant client. This never establishes an active selection or grants provider authority.
export async function getSettingsForConfigurationChange(installedNetwork: RpcNetwork): Promise<{ readonly settings: ConfigurationComparisonSettings, readonly hasReadableActiveNetwork: boolean }> {
	const { storedItems, rpcConfiguration, storageReadError } = await readSettingsStorage()
	if (storageReadError !== undefined) throw storageReadError.error
	const activeNetwork = 'activeRpcNetwork' in rpcConfiguration ? rpcConfiguration.activeRpcNetwork : undefined
	const settings = await getSettingsFromStorageItems(storedItems, activeNetwork ?? installedNetwork)
	return { settings: configurationComparisonSettings(settings), hasReadableActiveNetwork: activeNetwork !== undefined }
}

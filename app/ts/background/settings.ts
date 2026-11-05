import type { ActiveAddress, ExportedSettings, Page } from '../types/exportedSettingsTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { BlockExplorer, RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, type RichListElement, browserStorageLocalGet, browserStorageLocalSafeParse, browserStorageLocalSet, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, updateUserAddressBookEntries } from './storageVariables.js'
import { getRpcConfigurationStateWithStorageSnapshot } from './rpcConfigurationStorage.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_BLOCK_MANIPULATION, DEFAULT_RPCS } from '../config/defaults.js'
import { rpcConfigurationIsReady } from './rpcConfigurationAvailability.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import type { SigningAddressPreference, SigningAddressPreferences } from '../types/signerTypes.js'
import type { RpcConfigurationState } from './rpcConfigurationStorage.js'
import { hasOwnKey } from '../utils/typescript.js'
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

type StartupStorageDefaults = {
	independentActiveSimulationAddress: Settings['activeSimulationAddress']
	activeSigningSafeAddress: Settings['activeSigningSafeAddress']
	openedPageV2: Page
	useSignersAddressAsActiveAddress: boolean
	websiteAccess: WebsiteAccessArray
	simulationMode: boolean
	activeRpcNetwork: RpcNetwork
	makeCurrentAddressRich: boolean
	fixedAddressRichList: readonly RichListElement[]
	signingAddressPreferences: SigningAddressPreferences
}

async function getParsedStorageValueOrDefaultFromItems<Key extends keyof StartupStorageDefaults>(storedItems: Readonly<Record<string, unknown>>, key: Key, defaultValue: StartupStorageDefaults[Key]): Promise<StartupStorageDefaults[Key]> {
	const rawValue = storedItems[key]
	const storedItem = hasOwnKey(storedItems, key) ? { [key]: rawValue } : {}
	const parsedValue: Readonly<Partial<StartupStorageDefaults>> | undefined = browserStorageLocalSafeParse(storedItem)
	if (parsedValue !== undefined && key in parsedValue) return parsedValue[key] as StartupStorageDefaults[Key]
	if (rawValue === undefined) return defaultValue
	console.warn(`${ key } was corrupt:`)
	console.warn(rawValue)
	await browserStorageLocalSet({ [key]: defaultValue } as unknown as Parameters<typeof browserStorageLocalSet>[0])
	return defaultValue
}

async function getParsedStorageValueOrDefault<Key extends keyof StartupStorageDefaults>(key: Key, defaultValue: StartupStorageDefaults[Key]): Promise<StartupStorageDefaults[Key]> {
	return await getParsedStorageValueOrDefaultFromItems(await browser.storage.local.get(key), key, defaultValue)
}

const SETTINGS_STORAGE_KEYS = [
	'independentActiveSimulationAddress',
	'activeSigningSafeAddress',
	'openedPageV2',
	'useSignersAddressAsActiveAddress',
	'websiteAccess',
	'simulationMode',
] as const

const getWebsiteAccessFromStorageItems = async (storedItems: Readonly<Record<string, unknown>>) => sanitizeWebsiteAccess(await getParsedStorageValueOrDefaultFromItems(storedItems, 'websiteAccess', []))

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
	const activeSimulationAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'independentActiveSimulationAddress', missingFieldValues.activeSimulationAddress))
	const activeSigningSafeAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'activeSigningSafeAddress', missingFieldValues.activeSigningSafeAddress))
	const openedPagePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'openedPageV2', missingFieldValues.openedPage))
	const useSignersAddressAsActiveAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'useSignersAddressAsActiveAddress', missingFieldValues.useSignersAddressAsActiveAddress))
	const websiteAccessPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'websiteAccess', missingFieldValues.websiteAccess).then(sanitizeWebsiteAccess))
	const simulationModePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'simulationMode', missingFieldValues.simulationMode))
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

// Settings and the RPC configuration come from one storage read and must travel together through an admitted operation. Settings need an active RPC network, so `unavailable` carries only the approvals' own availability.
export type SettingsSnapshot =
	| { readonly status: 'available', readonly settings: Settings, readonly rpcConfiguration: RpcConfigurationState }
	| { readonly status: 'unavailable', readonly rpcConfiguration: RpcConfigurationState, readonly websiteApprovals: WebsiteApprovalsSnapshot }

const capturedRpcNetworkMarker = Symbol('capturedRpcNetwork')
export type CapturedRpcNetwork = {
	readonly activeRpcNetwork: RpcNetwork
	readonly [capturedRpcNetworkMarker]: true
}

// Long-lived mutations use this token only when later settings fields may change but the admitted RPC network must remain pinned.
export function captureRpcNetwork(settings: Settings): CapturedRpcNetwork {
	return { activeRpcNetwork: settings.activeRpcNetwork, [capturedRpcNetworkMarker]: true }
}

// A re-read for an admitted operation: `storedFields` are the persisted settings fields and `admittedRpcNetwork` is the operation's own network, which can differ from the persisted RPC configuration, so it is carried separately and is never presented as live settings.
export type AdmittedRpcNetworkSnapshot =
	| { readonly status: 'available', readonly storedFields: SettingsStorageFields, readonly admittedRpcNetwork: CapturedRpcNetwork }
	| { readonly status: 'unreadable', readonly error: unknown }

const getStorageReadError = (rpcConfiguration: RpcConfigurationState) => rpcConfiguration.status === 'unavailable' && rpcConfiguration.reason === 'read-failed' ? { error: 'error' in rpcConfiguration ? rpcConfiguration.error : undefined } : undefined

// The one storage read both settings reads share, so they always agree on what was stored and whether storage could be read.
async function readSettingsStorage() {
	const { storedItems, rpcConfiguration } = await getRpcConfigurationStateWithStorageSnapshot(SETTINGS_STORAGE_KEYS)
	return { storedItems, rpcConfiguration, storageReadError: getStorageReadError(rpcConfiguration) }
}

// The persisted settings, available only while the stored RPC configuration has an active RPC network.
export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
	const { storedItems, rpcConfiguration, storageReadError } = await readSettingsStorage()
	const activeRpcNetwork = 'activeRpcNetwork' in rpcConfiguration ? rpcConfiguration.activeRpcNetwork : undefined
	if (activeRpcNetwork !== undefined) return { status: 'available', settings: await getSettingsFromStorageItems(storedItems, activeRpcNetwork), rpcConfiguration }
	const websiteApprovals: WebsiteApprovalsSnapshot = storageReadError === undefined
		? { status: 'readable', websiteAccess: await getWebsiteAccessFromStorageItems(storedItems) }
		: { status: 'unreadable', error: storageReadError.error }
	return { status: 'unavailable', rpcConfiguration, websiteApprovals }
}

// The re-read for an admitted operation: the persisted settings fields beside the operation's own admitted network, whatever the stored RPC configuration says; unreadable only when storage cannot be read. Project it with settingsOnAdmittedRpcNetwork or settingsForPublication.
export async function getAdmittedRpcNetworkSnapshot(admittedRpcNetwork: CapturedRpcNetwork): Promise<AdmittedRpcNetworkSnapshot> {
	const { storedItems, storageReadError } = await readSettingsStorage()
	if (storageReadError !== undefined) return { status: 'unreadable', error: storageReadError.error }
	return { status: 'available', storedFields: await getSettingsFieldsFromStorageItems(storedItems), admittedRpcNetwork }
}

// The approvals-only read, for paths that must not wait on the RPC configuration lock. `repairCorrupt` writes no approvals over a corrupt value (a failed write is unreadable); without it a corrupt value reads as no approvals and nothing is written.
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

// Projection for operations that cannot continue without settings: throws the RPC-configuration-unavailable error.
export function requireAvailableSettings(snapshot: SettingsSnapshot): Settings {
	if (snapshot.status === 'unavailable') throw createRpcConfigurationUnavailableError()
	return snapshot.settings
}

// Projection for callers that branch on availability themselves and only need the settings fields. An unavailable RPC configuration that kept a readable active network (corrupt, emptied or unwritable entries) still has settings, so this says nothing about whether the configuration is usable.
export function settingsIfAvailable(snapshot: SettingsSnapshot): Settings | undefined {
	return snapshot.status === 'available' ? snapshot.settings : undefined
}

// Projection for decisions that must treat every unavailable RPC configuration alike, such as granting access or choosing how tabs are blocked: settings only while the RPC configuration is ready.
export function settingsIfRpcConfigurationReady(snapshot: SettingsSnapshot): Settings | undefined {
	return rpcConfigurationIsReady(snapshot.rpcConfiguration) ? settingsIfAvailable(snapshot) : undefined
}

// Projection for granting access: unreadable approvals fail closed to none.
export function approvalsOrNone(snapshot: SettingsSnapshot | WebsiteApprovalsSnapshot): WebsiteAccessArray {
	if (snapshot.status === 'available') return snapshot.settings.websiteAccess
	const websiteApprovals = snapshot.status === 'unavailable' ? snapshot.websiteApprovals : snapshot
	return websiteApprovals.status === 'readable' ? websiteApprovals.websiteAccess : []
}

// Projection for paths where a failed read must stop the caller (for example so applied request blocks stay in place): rethrows the storage error.
export function requireReadableApprovals(websiteApprovals: WebsiteApprovalsSnapshot): WebsiteAccessArray {
	if (websiteApprovals.status === 'unreadable') throw websiteApprovals.error
	return websiteApprovals.websiteAccess
}

const liveSettingsMarker = Symbol('liveSettings')
// Settings proven to come from a ready RPC configuration on the network the caller worked on. Granting a connection takes this type (see verifyAccess), so code that holds plain settings cannot grant. The proof lasts only until the next await: read it immediately before the grant, with no await in between.
export type LiveSettings = Settings & { readonly [liveSettingsMarker]: true }

export type AdmittedRpcNetworkNoLongerLive = 'unavailable' | 'chain-changed' | 'endpoint-changed'

export type LiveSettingsOnAdmittedRpcNetwork =
	| { readonly kind: 'ready', readonly settings: LiveSettings }
	| { readonly kind: AdmittedRpcNetworkNoLongerLive }

// The single check behind every connection grant, and behind routing a request: work can be parked on the website lookup, signer prompts or address lookups after it read its settings, so one live snapshot is read and used unmixed. A metadata-only change (name, explorer, list preferences) keeps the chain and endpoint, so the live snapshot still matches the admitted service pair; a chain change invalidates the live selection's chain-dependent decisions for the admitted pair.
export async function getLiveSettingsOnAdmittedRpcNetwork(admittedSettings: Settings): Promise<LiveSettingsOnAdmittedRpcNetwork> {
	const liveSettings = settingsIfRpcConfigurationReady(await getSettingsSnapshot())
	if (liveSettings === undefined) return { kind: 'unavailable' }
	const rpcNetworkChange = getRpcNetworkChange(admittedSettings.activeRpcNetwork, liveSettings.activeRpcNetwork)
	if (rpcNetworkChange.chainChanged) return { kind: 'chain-changed' }
	// Rejected rather than continued: the admitted service pair still talks to the deselected endpoint (which the user may have left for privacy or reliability), and a signer-only selection's fallback service may serve another chain.
	if (rpcNetworkChange.endpointChanged) return { kind: 'endpoint-changed' }
	return { kind: 'ready', settings: { ...liveSettings, [liveSettingsMarker]: true } }
}

// Projection for an admitted operation that continues on its own network: the persisted fields on the admitted RPC network, undefined when storage is unreadable.
export function settingsOnAdmittedRpcNetwork(snapshot: AdmittedRpcNetworkSnapshot): Settings | undefined {
	return snapshot.status === 'available' ? withActiveRpcNetwork(snapshot.storedFields, snapshot.admittedRpcNetwork.activeRpcNetwork) : undefined
}

// Settings a committing operation publishes when it cannot read them back: without website approvals, so revoked approvals are never republished. This limits only the publication; access reconciliation decides with its own read inside its lock, and only when that read also fails does it use these settings, revoke-only (see reconcileWebsiteApprovalAccesses).
export const settingsWithoutApprovals = (settings: Settings): Settings => ({ ...settings, websiteAccess: [] })

// Projection for settings that must still be published when they cannot be read back: `fallback` without website approvals.
export function settingsForPublication(snapshot: AdmittedRpcNetworkSnapshot, fallback: Settings): Settings {
	return settingsOnAdmittedRpcNetwork(snapshot) ?? settingsWithoutApprovals(fallback)
}

export const setPage = async (openedPageV2: Page) => await browserStorageLocalSet({ openedPageV2 })
export const getPage = async() => (await browserStorageLocalGet('openedPageV2'))?.openedPageV2 ?? { page: 'Home' }

const signingAddressPreferencesSemaphore = new Semaphore(1)

export async function getSigningAddressPreferences() {
	return await getParsedStorageValueOrDefault('signingAddressPreferences', [])
}

export async function rememberSigningAddressPreference(preference: SigningAddressPreference) {
	await signingAddressPreferencesSemaphore.execute(async () => {
		const preferences = await getSigningAddressPreferences()
		await browserStorageLocalSet({
			signingAddressPreferences: [
				...preferences.filter((existing) => existing.signerAddress !== preference.signerAddress),
				preference,
			],
		})
	})
}

export const setMakeCurrentAddressRich = async (makeCurrentAddressRich: boolean) => await browserStorageLocalSet({ makeCurrentAddressRich })
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

// The active-settings writers return the exact storage items they persisted. Those items are the single representation of the transition: they are written as-is and `getSettingsAfterStorageUpdates` projects Settings from them.
export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined): Promise<LocalStorageItems> {
	const storageUpdate = {
		useSignersAddressAsActiveAddress,
		...useSignersAddressAsActiveAddress === true ? { activeSigningAddress: currentSignerAddress } : {}
	}
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

function getSimulationModeStorageUpdate(changes: SimulationModeChanges) {
	return {
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { activeRpcNetwork: changes.rpcNetwork }: {},
		...'activeSimulationAddress' in changes ? { independentActiveSimulationAddress: changes.activeSimulationAddress } : {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: changes.activeSigningAddress }: {},
		...'activeSigningSafeAddress' in changes ? { activeSigningSafeAddress: changes.activeSigningSafeAddress }: {},
	}
}

export async function changeSimulationMode(changes: SimulationModeChanges): Promise<LocalStorageItems> {
	const storageUpdate = getSimulationModeStorageUpdate(changes)
	await browserStorageLocalSet(storageUpdate)
	return storageUpdate
}

// The Settings that committed storage updates produce, derived by running the serialized updates (applied in write order) through the same storage-to-Settings conversion used for reads; fields no update writes keep their previous values. No field mapping is repeated here.
export async function getSettingsAfterStorageUpdates(previousSettings: Settings, storageUpdates: readonly LocalStorageItems[]): Promise<Settings> {
	const updatedItems = storageUpdates.reduce<Record<string, unknown>>((items, storageUpdate) => ({ ...items, ...serializeLocalStorageItems(storageUpdate) }), {})
	const activeRpcNetwork = await getParsedStorageValueOrDefaultFromItems(updatedItems, 'activeRpcNetwork', previousSettings.activeRpcNetwork)
	return await getSettingsFromStorageItems(updatedItems, activeRpcNetwork, previousSettings)
}

async function replaceModeAndSigningPreferencesForImport(changes: SimulationModeChanges, signingAddressPreferences: SigningAddressPreferences) {
	return await signingAddressPreferencesSemaphore.execute(async () => await browserStorageLocalSet({
		...getSimulationModeStorageUpdate(changes),
		signingAddressPreferences,
	}))
}

const websiteAccessSemaphore = new Semaphore(1)
async function getNormalizedWebsiteAccessFromStorage() {
	const rawWebsiteAccess = await getParsedStorageValueOrDefault('websiteAccess', [])
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(rawWebsiteAccess)
	return { rawWebsiteAccess, sanitizedWebsiteAccess }
}

export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const { rawWebsiteAccess, sanitizedWebsiteAccess } = await getNormalizedWebsiteAccessFromStorage()
		const nextWebsiteAccess = sanitizeWebsiteAccess(updateFunc(sanitizedWebsiteAccess))
		if (nextWebsiteAccess === sanitizedWebsiteAccess && rawWebsiteAccess === sanitizedWebsiteAccess) return
		return await browserStorageLocalSet({ websiteAccess: nextWebsiteAccess })
	})
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
export const setUseTabsInsteadOfPopup = async(useTabsInsteadOfPopup: boolean) => await browserStorageLocalSet({ useTabsInsteadOfPopup })

export const getMetamaskCompatibilityMode = async() => (await browserStorageLocalGet('metamaskCompatibilityMode'))?.metamaskCompatibilityMode ?? false
export const setMetamaskCompatibilityMode = async(metamaskCompatibilityMode: boolean) => await browserStorageLocalSet({ metamaskCompatibilityMode })

export const getSafeAppsCompatibilityMode = async() => (await browserStorageLocalGet('safeAppsCompatibilityMode'))?.safeAppsCompatibilityMode ?? false
export const setSafeAppsCompatibilityMode = async(safeAppsCompatibilityMode: boolean) => await browserStorageLocalSet({ safeAppsCompatibilityMode })

export async function exportSettingsAndAddressBook(): Promise<ExportedSettings> {
	const exportDate = (new Date).toISOString().split('T')[0]
	if (exportDate === undefined) throw new Error('Datestring did not contain Date')
	const [settings, signingAddressPreferences] = await Promise.all([getSettingsSnapshot().then(requireAvailableSettings), getSigningAddressPreferences()])
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

export async function importSettingsAndAddressBook(exportedSetings: ExportedSettings) {
	// Pre-1.5 exports contain the legacy address shared by signing and simulation. Apply the same explicit default reset as startup rather than heuristically assigning ambiguous state to either independent mode.
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	if (defaultActiveAddress === undefined) throw new Error('Default active address was missing')
	if (exportedSetings.version === '1.3' || exportedSetings.version === '1.4' || exportedSetings.version === '1.5' || exportedSetings.version === '1.6') {
		await setPage(exportedSetings.settings.openedPage)
	}
	// Safe selection and per-signer preferences resolve through the address book. Make imported entries available before publishing that dependent signing state.
	if (exportedSetings.version === '1.4' || exportedSetings.version === '1.5' || exportedSetings.version === '1.6') {
		await updateUserAddressBookEntries(() => exportedSetings.settings.addressBookEntries)
	}
	if (exportedSetings.version === '1.0') {
		await replaceModeAndSigningPreferencesForImport({
			simulationMode: exportedSetings.settings.simulationMode,
			rpcNetwork: defaultRpcs[0],
			activeSimulationAddress: defaultActiveAddress,
			activeSigningAddress: undefined,
			activeSigningSafeAddress: undefined,
		}, [])
	} else {
		await replaceModeAndSigningPreferencesForImport({
			simulationMode: exportedSetings.settings.simulationMode,
			rpcNetwork: exportedSetings.settings.rpcNetwork,
			activeSimulationAddress: exportedSetings.version === '1.5' || exportedSetings.version === '1.6' ? exportedSetings.settings.activeSimulationAddress : defaultActiveAddress,
			activeSigningAddress: undefined,
			activeSigningSafeAddress: exportedSetings.version === '1.5' || exportedSetings.version === '1.6' ? exportedSetings.settings.activeSigningSafeAddress : undefined,
		}, exportedSetings.version === '1.5' || exportedSetings.version === '1.6' ? exportedSetings.settings.signingAddressPreferences : [])
	}
	await setUseSignersAddressAsActiveAddress(exportedSetings.settings.useSignersAddressAsActiveAddress)
	await updateWebsiteAccess(() => exportedSetings.settings.websiteAccess)
	await setUseTabsInsteadOfPopup(exportedSetings.settings.useTabsInsteadOfPopup)
	if (exportedSetings.version !== '1.0' && exportedSetings.version !== '1.1') {
		await setMetamaskCompatibilityMode(exportedSetings.settings.metamaskCompatibilityMode)
	}
	await setSafeAppsCompatibilityMode(exportedSetings.version === '1.6' ? exportedSetings.settings.safeAppsCompatibilityMode : false)
	if (exportedSetings.version !== '1.4' && exportedSetings.version !== '1.5' && exportedSetings.version !== '1.6') {
		await updateUserAddressBookEntries((previousEntries) => {
			const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
			return getUniqueItemsByProperties(previousEntries.concat(exportedSetings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSetings.settings.contacts ?? []), ['address'])
		})
	}
}

export const setPreSimulationBlockTimeManipulation = async (preSimulationBlockTimeManipulation: BlockTimeManipulation) => await browserStorageLocalSet({ preSimulationBlockTimeManipulation })
export const getPreSimulationBlockTimeManipulation = async() => (await browserStorageLocalGet('preSimulationBlockTimeManipulation'))?.preSimulationBlockTimeManipulation ?? DEFAULT_BLOCK_MANIPULATION

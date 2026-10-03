import { ContentScriptHostingSettings, contentScriptRegistrationSettingsKeys, type ContentScriptConfiguration } from '../types/contentScriptSettings.js'
import { getChromeSiteMatchPatterns } from '../utils/chromeMatchPatterns.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { createSettingsExport, normalizeImportedSettings, type ExportedSettings, type Page } from '../types/exportedSettingsTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { BlockExplorer, RpcNetwork } from '../types/rpc.js'
import { type RichListElement, browserStorageLocalGet, browserStorageLocalSafeParse, browserStorageLocalSet } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, updateUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_BLOCK_MANIPULATION, DEFAULT_RPCS } from '../config/defaults.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import type { SigningAddressPreference, SigningAddressPreferences } from '../types/signerTypes.js'
import { DEFAULT_SAFE_APPS_HOST_ORIGINS, SafeAppsHostOrigins } from '../types/safeAppsHosting.js'
import { hasOwnKey } from '../utils/typescript.js'

export { contentScriptRegistrationSettingsKeys }

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
	safeAppsHostOrigins: readonly string[]
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

export async function getSettings() : Promise<Settings> {
	if (defaultRpcs[0] === undefined || defaultActiveAddresses[0] === undefined) throw new Error('default rpc or default address was missing')
	const defaultPage: Page = { page: 'Home' }
	const storedItems = await silenceChromeUnCaughtPromise(browser.storage.local.get([
		'independentActiveSimulationAddress',
		'activeSigningSafeAddress',
		'openedPageV2',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'simulationMode',
		'activeRpcNetwork',
	]))
	const activeSimulationAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'independentActiveSimulationAddress', defaultActiveAddresses[0].address))
	const activeSigningSafeAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'activeSigningSafeAddress', undefined))
	const openedPagePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'openedPageV2', defaultPage))
	const useSignersAddressAsActiveAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'useSignersAddressAsActiveAddress', false))
	const websiteAccessPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'websiteAccess', []).then(sanitizeWebsiteAccess))
	const simulationModePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'simulationMode', defaultSimulationMode))
	const activeRpcNetworkPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefaultFromItems(storedItems, 'activeRpcNetwork', defaultRpcs[0]))
	const [activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, activeRpcNetwork, simulationMode] = await Promise.all([
		activeSimulationAddressPromise,
		activeSigningSafeAddressPromise,
		openedPagePromise,
		useSignersAddressAsActiveAddressPromise,
		websiteAccessPromise,
		activeRpcNetworkPromise,
		simulationModePromise,
	])
	return { activeSimulationAddress, activeSigningSafeAddress, openedPage, useSignersAddressAsActiveAddress, websiteAccess, activeRpcNetwork, simulationMode }
}

export function getInterceptorDisabledSites(settings: Pick<Settings, 'websiteAccess'>): string[] {
	return settings.websiteAccess.filter((site) => site.interceptorDisabled === true).map((site) => site.website.websiteOrigin)
}

// Read once for both the cache identity and desired registrations; validate hosting separately so its corruption cannot disable the ordinary provider.
export async function getContentScriptConfiguration(): Promise<ContentScriptConfiguration> {
	const storedItems = await browser.storage.local.get(contentScriptRegistrationSettingsKeys)
	const websiteAccess = sanitizeWebsiteAccess(await getParsedStorageValueOrDefaultFromItems(storedItems, 'websiteAccess', []))
	return {
		cacheKey: JSON.stringify(storedItems),
		excludeMatches: getChromeSiteMatchPatterns(getInterceptorDisabledSites({ websiteAccess })),
		hosting: getHostingConfiguration(storedItems),
	}
}

function getHostingConfiguration(storedItems: unknown): ContentScriptConfiguration['hosting'] {
	const compatibility = ContentScriptHostingSettings.pick('safeAppsCompatibilityMode').safeParse(storedItems)
	if (!compatibility.success) return { error: new Error(compatibility.message) }
	// Unselected hosting data is inert while compatibility is disabled, just as in the ordinary settings getters.
	if (compatibility.value.safeAppsCompatibilityMode !== true) return { matches: [], origins: DEFAULT_SAFE_APPS_HOST_ORIGINS }
	const hosting = ContentScriptHostingSettings.safeParse(storedItems)
	if (!hosting.success) return { error: new Error(hosting.message) }
	const origins = hosting.value.safeAppsHostOrigins ?? DEFAULT_SAFE_APPS_HOST_ORIGINS
	return { matches: getSafeAppsHostMatchPatterns(origins), origins }
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

export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined) {
	return await browserStorageLocalSet({
		useSignersAddressAsActiveAddress,
		...useSignersAddressAsActiveAddress === true ? { activeSigningAddress: currentSignerAddress } : {}
	})
}

type SimulationModeChanges = {
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

export async function changeSimulationMode(changes: SimulationModeChanges) {
	return await browserStorageLocalSet(getSimulationModeStorageUpdate(changes))
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

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
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

export const getSafeAppsHostOrigins = async () => await getParsedStorageValueOrDefault('safeAppsHostOrigins', DEFAULT_SAFE_APPS_HOST_ORIGINS)
export const setSafeAppsHostOrigins = async (origins: readonly string[]) => await browserStorageLocalSet({ safeAppsHostOrigins: SafeAppsHostOrigins.parse(origins) })

export async function getEnabledSafeAppsHostOrigins() {
	return await getSafeAppsCompatibilityMode() ? await getSafeAppsHostOrigins() : DEFAULT_SAFE_APPS_HOST_ORIGINS
}

export async function exportSettingsAndAddressBook(): Promise<ExportedSettings> {
	const exportDate = (new Date).toISOString().split('T')[0]
	if (exportDate === undefined) throw new Error('Datestring did not contain Date')
	const [settings, signingAddressPreferences] = await Promise.all([getSettings(), getSigningAddressPreferences()])
	return createSettingsExport({
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
		safeAppsHostOrigins: await getSafeAppsHostOrigins(),
	}, exportDate)
}

export async function importSettingsAndAddressBook(exportedSettings: ExportedSettings) {
	const defaultActiveAddress = defaultActiveAddresses[0]?.address
	const defaultRpcNetwork = defaultRpcs[0]
	if (defaultActiveAddress === undefined || defaultRpcNetwork === undefined) throw new Error('Default active address or RPC was missing')
	const settings = normalizeImportedSettings(exportedSettings, { activeSimulationAddress: defaultActiveAddress, rpcNetwork: defaultRpcNetwork })
	if (settings.openedPage !== undefined) await setPage(settings.openedPage)
	// Safe selection and per-signer preferences resolve through the address book; publish imported entries first.
	const addressBookEntries = settings.addressBookEntries
	if (addressBookEntries !== undefined) await updateUserAddressBookEntries(() => addressBookEntries)
	await replaceModeAndSigningPreferencesForImport({
		simulationMode: settings.simulationMode,
		rpcNetwork: settings.rpcNetwork,
		activeSimulationAddress: settings.activeSimulationAddress,
		activeSigningAddress: undefined,
		activeSigningSafeAddress: settings.activeSigningSafeAddress,
	}, settings.signingAddressPreferences)
	await setUseSignersAddressAsActiveAddress(settings.useSignersAddressAsActiveAddress)
	await updateWebsiteAccess(() => settings.websiteAccess)
	await setUseTabsInsteadOfPopup(settings.useTabsInsteadOfPopup)
	if (settings.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(settings.metamaskCompatibilityMode)
	await setSafeAppsHostOrigins(settings.safeAppsHostOrigins)
	await setSafeAppsCompatibilityMode(settings.safeAppsCompatibilityMode)
	const legacyEntries = settings.legacyAddressBookEntries
	if (legacyEntries !== undefined) await updateUserAddressBookEntries((previousEntries) => getUniqueItemsByProperties(previousEntries.concat(legacyEntries), ['address']))
}

export const setPreSimulationBlockTimeManipulation = async (preSimulationBlockTimeManipulation: BlockTimeManipulation) => await browserStorageLocalSet({ preSimulationBlockTimeManipulation })
export const getPreSimulationBlockTimeManipulation = async() => (await browserStorageLocalGet('preSimulationBlockTimeManipulation'))?.preSimulationBlockTimeManipulation ?? DEFAULT_BLOCK_MANIPULATION

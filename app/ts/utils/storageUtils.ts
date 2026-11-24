import { captureStorageWritesTo, writeLocalStorage } from './localStorageWrites.js'
import type { StorageWriteValue } from './storageWriteTracking.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumAddressOrMissing, EthereumQuantity, LiteralConverterParserFactory, serialize } from '../types/wire-types.js'
import { PendingChainChangeConfirmationPromise, PendingFetchSimulationStackRequestPromise, RpcConnectionStatus, StoredWatchAssetRequest, TabState } from '../types/user-interface-types.js'
import { BlockTimeManipulation, CompleteVisualizedSimulation, EthereumSubscriptionsAndFilters, InterceptorTransactionStack } from '../types/visualizer-types.js'
import { AddressBookEntries, AddressBookEntry, EntrySource } from '../types/addressBookTypes.js'
import { Page } from '../types/exportedSettingsTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { SignerName, SigningAddressPreferences } from '../types/signerTypes.js'
import { PendingAccessRequests, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { ENSLabelHashes, ENSNameHashes } from '../types/ens.js'
import { UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { InterceptorErrorDiagnostic } from '../types/errorDiagnostics.js'
import { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { RichAccountBalances, RichToken, RichModeState, RichListElement } from '../types/richMode.js'
import { ICON_ACCESS_DENIED } from './constants.js'
import { hasOwnKey } from './typescript.js'

type IdsOfOpenedTabs = funtypes.Static<typeof IdsOfOpenedTabs>
const IdsOfOpenedTabs = funtypes.Intersect(
	funtypes.ReadonlyObject({
		addressBook: funtypes.Union(funtypes.Undefined, funtypes.Number),
		settingsView: funtypes.Union(funtypes.Undefined, funtypes.Number),
		websiteAccess: funtypes.Union(funtypes.Undefined, funtypes.Number),
	}),
	funtypes.ReadonlyPartial({
		simulationStack: funtypes.Union(funtypes.Undefined, funtypes.Number),
	}),
)

export type PartialIdsOfOpenedTabs = funtypes.Static<typeof PartialIdsOfOpenedTabs>
export const PartialIdsOfOpenedTabs = funtypes.ReadonlyPartial({
	addressBook: funtypes.Union(funtypes.Undefined, funtypes.Number),
	settingsView: funtypes.Union(funtypes.Undefined, funtypes.Number),
	websiteAccess: funtypes.Union(funtypes.Undefined, funtypes.Number),
	simulationStack: funtypes.Union(funtypes.Undefined, funtypes.Number),
})

export type OldActiveAddressEntry = funtypes.Static<typeof OldActiveAddressEntry>
export const OldActiveAddressEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('activeAddress'),
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
	entrySource: EntrySource,
})

export { RichListElement } from '../types/richMode.js'

// Shared with startup reads so validating one setting never traverses unrelated storage unions.
const startupStorageCodecs = {
	independentActiveSimulationAddress: EthereumAddressOrMissing,
	activeSigningSafeAddress: EthereumAddressOrMissing,
	openedPageV2: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
	activeRpcNetwork: RpcNetwork,
	makeCurrentAddressRich: funtypes.Boolean,
	fixedAddressRichList: funtypes.ReadonlyArray(RichListElement),
	signingAddressPreferences: SigningAddressPreferences,
}

export type StartupStorageValues = { [Key in keyof typeof startupStorageCodecs]: funtypes.Static<typeof startupStorageCodecs[Key]> }
const startupStorageValueCodecs: { [Key in keyof StartupStorageValues]: funtypes.Codec<StartupStorageValues[Key]> } = startupStorageCodecs

// Tracked keys have one write owner: the tracked local-storage facade. Other storage schemas and read-time repair exclude them, so a stale read cannot overwrite an explicit mode change.
type TrackedLocalStorageValues = Pick<StartupStorageValues, 'simulationMode'>
type TrackedLocalStorageKey = keyof TrackedLocalStorageValues
type StartupStorageRepairWriters = { [Key in keyof StartupStorageValues]: ((value: StartupStorageValues[Key]) => Promise<void>) | undefined }
type RequiredStartupStorageRepairs = { [Key in Exclude<keyof StartupStorageValues, TrackedLocalStorageKey>]: (value: StartupStorageValues[Key]) => Promise<void> } & { readonly [Key in TrackedLocalStorageKey]: undefined }
// Every startup key declares its repair policy; only tracked keys may explicitly decline repair.
const startupStorageDefaultWriters: StartupStorageRepairWriters = {
	simulationMode: undefined,
	independentActiveSimulationAddress: async (value) => await browserStorageLocalSet({ independentActiveSimulationAddress: value }),
	activeSigningSafeAddress: async (value) => await browserStorageLocalSet({ activeSigningSafeAddress: value }),
	openedPageV2: async (value) => await browserStorageLocalSet({ openedPageV2: value }),
	useSignersAddressAsActiveAddress: async (value) => await browserStorageLocalSet({ useSignersAddressAsActiveAddress: value }),
	websiteAccess: async (value) => await browserStorageLocalSet({ websiteAccess: value }),
	activeRpcNetwork: async (value) => await browserStorageLocalSet({ activeRpcNetwork: value }),
	makeCurrentAddressRich: async (value) => await browserStorageLocalSet({ makeCurrentAddressRich: value }),
	fixedAddressRichList: async (value) => await browserStorageLocalSet({ fixedAddressRichList: value }),
	signingAddressPreferences: async (value) => await browserStorageLocalSet({ signingAddressPreferences: value }),
} satisfies RequiredStartupStorageRepairs

export async function getStartupStorageValueOrDefault<Key extends keyof StartupStorageValues>(storedItems: Readonly<Record<string, unknown>>, key: Key, defaultValue: StartupStorageValues[Key]): Promise<StartupStorageValues[Key]> {
	const rawValue = storedItems[key]
	// Check presence before decoding: the stored 'missing' marker decodes to undefined, but represents an explicitly cleared address and must not select the default.
	if (!hasOwnKey(storedItems, key) || rawValue === undefined) return defaultValue
	const parsedValue = startupStorageValueCodecs[key].safeParse(rawValue)
	if (parsedValue.success) return parsedValue.value
	console.warn(`${ key } was corrupt:`)
	console.warn(rawValue)
	await startupStorageDefaultWriters[key]?.(defaultValue)
	return defaultValue
}

const { independentActiveSimulationAddress, activeSigningSafeAddress, ...startupStoragePartialCodecs } = startupStorageCodecs

// ReadonlyPartial drops a property whose serialized value represents `undefined`. These presence-aware alternatives preserve the distinction between "not stored" and "explicitly cleared", which independent address update paths rely on.
const presenceAwareOptionalAddress = (propertyName: 'activeSigningAddress' | 'activeSigningSafeAddress' | 'independentActiveSimulationAddress', codec: typeof EthereumAddressOrMissing) => funtypes.Union(
	funtypes.ReadonlyObject({ [propertyName]: codec })
		.withConstraint((item) => hasOwnKey(item, propertyName)),
	funtypes.ReadonlyPartial({ [propertyName]: funtypes.Unknown })
		.withConstraint((item) => !hasOwnKey(item, propertyName)),
)
const OptionalActiveSigningAddressStorageProperty = presenceAwareOptionalAddress('activeSigningAddress', EthereumAddressOrMissing)
const OptionalActiveSigningSafeAddressStorageProperty = presenceAwareOptionalAddress('activeSigningSafeAddress', activeSigningSafeAddress)
const OptionalIndependentActiveSimulationAddressStorageProperty = presenceAwareOptionalAddress('independentActiveSimulationAddress', independentActiveSimulationAddress)
const LocalStorageItemsRuntype = funtypes.Intersect(funtypes.ReadonlyPartial({
	...startupStoragePartialCodecs,
	pendingInterceptorAccessRequests: PendingAccessRequests,
	richNativeAmount: EthereumQuantity,
	chainChangeConfirmationPromise: funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise),
	interceptorTransactionStack: funtypes.Union(funtypes.Undefined, InterceptorTransactionStack),
	popupVisualisation: funtypes.Union(funtypes.Undefined, CompleteVisualizedSimulation),
	signerName: SignerName,
	currentTabId: funtypes.Union(funtypes.Undefined, funtypes.Number),
	rpcConnectionStatus: RpcConnectionStatus,
	ethereumSubscriptionsAndFilters: EthereumSubscriptionsAndFilters,
	useTabsInsteadOfPopup: funtypes.Boolean,
	rpcEntries: RpcEntries,
	metamaskCompatibilityMode: funtypes.Boolean,
	safeAppsCompatibilityMode: funtypes.Boolean,
	userAddressBookEntries: funtypes.ReadonlyArray(funtypes.Union(AddressBookEntry, OldActiveAddressEntry)),
	userAddressBookEntriesV2: AddressBookEntries,
	userAddressBookEntriesV3: AddressBookEntries,
	idsOfOpenedTabs: IdsOfOpenedTabs,
	interceptorDisabled: funtypes.Boolean,
	interceptorStartSleepingTimestamp: funtypes.Number,
	latestUnexpectedError: UnexpectedErrorOccured,
	interceptorErrorDiagnostics: funtypes.ReadonlyArray(InterceptorErrorDiagnostic),
	ensNameHashes: ENSNameHashes,
	ensLabelHashes: ENSLabelHashes,
	preSimulationBlockTimeManipulation: BlockTimeManipulation,
	richTokens: funtypes.ReadonlyArray(RichToken),
	richAccountBalances: RichAccountBalances,
	richModeState: RichModeState,
	fetchSimulationStackRequestPromise: funtypes.Union(funtypes.Undefined, PendingFetchSimulationStackRequestPromise),
	pendingWatchAssetRequests: funtypes.ReadonlyArray(StoredWatchAssetRequest),
	popupRefreshGeneration: funtypes.Number,
	pendingTerminalReplies: funtypes.ReadonlyArray(InterceptedRequestForward),
}), OptionalActiveSigningAddressStorageProperty, OptionalActiveSigningSafeAddressStorageProperty, OptionalIndependentActiveSimulationAddressStorageProperty)
export type LocalStorageItems = funtypes.Static<typeof LocalStorageItemsRuntype>
const LocalStorageItems: typeof LocalStorageItemsRuntype = LocalStorageItemsRuntype

type LocalStorageKey = funtypes.Static<typeof LocalStorageKey>
const LocalStorageKey = funtypes.Union(
	funtypes.Literal('activeSigningAddress'),
	funtypes.Literal('activeSigningSafeAddress'),
	funtypes.Literal('independentActiveSimulationAddress'),
	funtypes.Literal('openedPageV2'),
	funtypes.Literal('useSignersAddressAsActiveAddress'),
	funtypes.Literal('websiteAccess'),
	funtypes.Literal('activeRpcNetwork'),
	funtypes.Literal('simulationMode'),
	funtypes.Literal('pendingInterceptorAccessRequests'),
	funtypes.Literal('makeCurrentAddressRich'),
	funtypes.Literal('richNativeAmount'),
	funtypes.Literal('chainChangeConfirmationPromise'),
	funtypes.Literal('interceptorTransactionStack'),
	funtypes.Literal('popupVisualisation'),
	funtypes.Literal('signerName'),
	funtypes.Literal('signingAddressPreferences'),
	funtypes.Literal('currentTabId'),
	funtypes.Literal('rpcConnectionStatus'),
	funtypes.Literal('ethereumSubscriptionsAndFilters'),
	funtypes.Literal('useTabsInsteadOfPopup'),
	funtypes.Literal('rpcEntries'),
	funtypes.Literal('metamaskCompatibilityMode'),
	funtypes.Literal('safeAppsCompatibilityMode'),
	funtypes.Literal('userAddressBookEntries'),
	funtypes.Literal('userAddressBookEntriesV2'),
	funtypes.Literal('userAddressBookEntriesV3'),
	funtypes.Literal('idsOfOpenedTabs'),
	funtypes.Literal('interceptorStartSleepingTimestamp'),
	funtypes.Literal('latestUnexpectedError'),
	funtypes.Literal('interceptorErrorDiagnostics'),
	funtypes.Literal('ensNameHashes'),
	funtypes.Literal('ensLabelHashes'),
	funtypes.Literal('preSimulationBlockTimeManipulation'),
	funtypes.Literal('fixedAddressRichList'),
	funtypes.Literal('richTokens'),
	funtypes.Literal('richAccountBalances'),
	funtypes.Literal('richModeState'),
	funtypes.Literal('fetchSimulationStackRequestPromise'),
	funtypes.Literal('pendingWatchAssetRequests'),
	funtypes.Literal('popupRefreshGeneration'),
	funtypes.Literal('pendingTerminalReplies'),
)

const localStorageItems2Codecs = {
	pendingTransactionsAndMessages: funtypes.ReadonlyArray(PendingTransactionOrSignableMessage),
} satisfies Record<string, unknown> & { readonly [Key in TrackedLocalStorageKey]?: never }

const LocalStorageItems2Runtype: funtypes.Partial<{
	pendingTransactionsAndMessages: funtypes.ReadonlyArray<typeof PendingTransactionOrSignableMessage>
}, true> = funtypes.ReadonlyPartial(localStorageItems2Codecs)
type LocalStorageItems2 = funtypes.Static<typeof LocalStorageItems2Runtype>
const LocalStorageItems2: typeof LocalStorageItems2Runtype = LocalStorageItems2Runtype

type LocalStorageKey2 = funtypes.Static<typeof LocalStorageKey2>
const LocalStorageKey2 = funtypes.Union(
	funtypes.Literal('pendingTransactionsAndMessages'),
)

// these methods are split to 1 and 2 to make the funtypes types simpler
export async function browserStorageLocalGet2(keys: LocalStorageKey2 | LocalStorageKey2[]): Promise<LocalStorageItems2> {
	return LocalStorageItems2.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}

export async function browserStorageLocalGet2Result(keys: LocalStorageKey2 | LocalStorageKey2[]) {
	const storedItems = await browser.storage.local.get(Array.isArray(keys) ? keys : [keys])
	try {
		return { success: true as const, value: LocalStorageItems2.parse(storedItems) }
	} catch (error) {
		if (!(error instanceof funtypes.ValidationError)) throw error
		return { success: false as const, error }
	}
}

export async function browserStorageLocalSet2(items: LocalStorageItems2) {
	return await writeLocalStorage(serialize(LocalStorageItems2, items))
}

export async function browserStorageLocalGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems> {
	return LocalStorageItems.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}
export function browserStorageLocalSafeParse(items: unknown): LocalStorageItems | undefined {
	const parsed = LocalStorageItems.safeParse(items)
	if (parsed.success) return parsed.value
	return undefined
}
export async function browserStorageLocalSafeParseGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems | undefined> {
	return browserStorageLocalSafeParse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}

export async function browserStorageLocalRemove(keys: LocalStorageKey | LocalStorageKey[]) {
	return await browser.storage.local.remove(Array.isArray(keys) ? keys : [keys])
}
// One storage owner records all writes. Higher-level consumers capture only the typed key/value relevant to their decision; the writer knows no domain-specific policy.
export const captureLocalStorageWritesTo = <Key extends TrackedLocalStorageKey>(key: Key, value: TrackedLocalStorageValues[Key] & StorageWriteValue) => captureStorageWritesTo(key, value)

export async function browserStorageLocalSet(items: LocalStorageItems) {
	const serialized = serialize(LocalStorageItems, items)
	return await writeLocalStorage(serialized)
}

const getTabStateKey = (tabId: number): `tabState_${ number }` => `tabState_${ tabId }`

type TabStateItems = funtypes.Static<typeof TabStateItems>
export const TabStateItems = funtypes.Record(funtypes.String, TabState)
const LEGACY_ACCESS_DENIED_SHIELD_ICON = '../img/head-access-denied-shield.png'

function normalizeLegacyTabStateIcons(items: unknown) {
	if (typeof items !== 'object' || items === null) return items
	return Object.fromEntries(Object.entries(items).map(([key, value]) => {
		if (typeof value !== 'object' || value === null || !('tabIconDetails' in value)) return [key, value]
		const tabIconDetails = value.tabIconDetails
		if (typeof tabIconDetails !== 'object' || tabIconDetails === null || !('icon' in tabIconDetails)) return [key, value]
		if (tabIconDetails.icon !== LEGACY_ACCESS_DENIED_SHIELD_ICON) return [key, value]
		return [key, { ...value, tabIconDetails: { ...tabIconDetails, icon: ICON_ACCESS_DENIED } }]
	}))
}

export const parseTabStateItems = (items: unknown) => TabStateItems.parse(normalizeLegacyTabStateIcons(items))

export async function getTabStateFromStorage(tabId: number) {
	return parseTabStateItems(await browser.storage.local.get(getTabStateKey(tabId)))?.[getTabStateKey(tabId)] ?? undefined
}
export async function setTabStateToStorage(tabId: number, tabState: TabState) {
	await writeLocalStorage({ [getTabStateKey(tabId)]: serialize(TabState, tabState) })
}
export const removeTabStateFromStorage = async (tabId: number) => await browser.storage.local.remove(getTabStateKey(tabId))

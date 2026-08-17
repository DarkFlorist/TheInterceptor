import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumAddressOrMissing, LiteralConverterParserFactory, serialize } from '../types/wire-types.js'
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
import { ICON_ACCESS_DENIED } from './constants.js'
import { hasOwnKey } from './methodHandlers.js'

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

export type RichListElement = funtypes.Static<typeof RichListElement>
export const RichListElement = funtypes.ReadonlyObject({
	address: EthereumAddress,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('CurrentActiveAddress'), funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded')),
})

// ReadonlyPartial drops a property whose serialized value represents `undefined`. These presence-aware alternatives preserve the distinction between "not stored" and "explicitly cleared", which independent address update paths rely on.
const presenceAwareOptionalAddress = (propertyName: 'activeSigningAddress' | 'activeSigningSafeAddress' | 'activeSimulationAddress') => funtypes.Union(
	funtypes.ReadonlyObject({ [propertyName]: EthereumAddressOrMissing })
		.withConstraint((item) => hasOwnKey(item, propertyName)),
	funtypes.ReadonlyPartial({ [propertyName]: funtypes.Unknown })
		.withConstraint((item) => !hasOwnKey(item, propertyName)),
)
const OptionalActiveSigningAddressStorageProperty = presenceAwareOptionalAddress('activeSigningAddress')
const OptionalActiveSigningSafeAddressStorageProperty = presenceAwareOptionalAddress('activeSigningSafeAddress')
const OptionalActiveSimulationAddressStorageProperty = presenceAwareOptionalAddress('activeSimulationAddress')
const LocalStorageItemsRuntype = funtypes.Intersect(funtypes.ReadonlyPartial({
	openedPageV2: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	activeRpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
	hasIndependentActiveSimulationAddress: funtypes.Boolean,
	pendingInterceptorAccessRequests: PendingAccessRequests,
	makeCurrentAddressRich: funtypes.Boolean,
	chainChangeConfirmationPromise: funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise),
	interceptorTransactionStack: funtypes.Union(funtypes.Undefined, InterceptorTransactionStack),
	popupVisualisation: funtypes.Union(funtypes.Undefined, CompleteVisualizedSimulation),
	signerName: SignerName,
	signingAddressPreferences: SigningAddressPreferences,
	currentTabId: funtypes.Union(funtypes.Undefined, funtypes.Number),
	rpcConnectionStatus: RpcConnectionStatus,
	ethereumSubscriptionsAndFilters: EthereumSubscriptionsAndFilters,
	useTabsInsteadOfPopup: funtypes.Boolean,
	rpcEntries: RpcEntries,
	metamaskCompatibilityMode: funtypes.Boolean,
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
	fixedAddressRichList: funtypes.ReadonlyArray(RichListElement),
	fetchSimulationStackRequestPromise: funtypes.Union(funtypes.Undefined, PendingFetchSimulationStackRequestPromise),
	pendingWatchAssetRequests: funtypes.ReadonlyArray(StoredWatchAssetRequest),
	popupRefreshGeneration: funtypes.Number,
	pendingTerminalReplies: funtypes.ReadonlyArray(InterceptedRequestForward),
}), OptionalActiveSigningAddressStorageProperty, OptionalActiveSigningSafeAddressStorageProperty, OptionalActiveSimulationAddressStorageProperty)
type LocalStorageItems = funtypes.Static<typeof LocalStorageItemsRuntype>
const LocalStorageItems: typeof LocalStorageItemsRuntype = LocalStorageItemsRuntype

type LocalStorageKey = funtypes.Static<typeof LocalStorageKey>
const LocalStorageKey = funtypes.Union(
	funtypes.Literal('activeSigningAddress'),
	funtypes.Literal('activeSigningSafeAddress'),
	funtypes.Literal('activeSimulationAddress'),
	funtypes.Literal('hasIndependentActiveSimulationAddress'),
	funtypes.Literal('openedPageV2'),
	funtypes.Literal('useSignersAddressAsActiveAddress'),
	funtypes.Literal('websiteAccess'),
	funtypes.Literal('activeRpcNetwork'),
	funtypes.Literal('simulationMode'),
	funtypes.Literal('pendingInterceptorAccessRequests'),
	funtypes.Literal('makeCurrentAddressRich'),
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
	funtypes.Literal('fetchSimulationStackRequestPromise'),
	funtypes.Literal('pendingWatchAssetRequests'),
	funtypes.Literal('popupRefreshGeneration'),
	funtypes.Literal('pendingTerminalReplies'),
)

const LocalStorageItems2Runtype: funtypes.Partial<{
	pendingTransactionsAndMessages: funtypes.ReadonlyArray<typeof PendingTransactionOrSignableMessage>
}, true> = funtypes.ReadonlyPartial({
	pendingTransactionsAndMessages: funtypes.ReadonlyArray(PendingTransactionOrSignableMessage)
})
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

export async function browserStorageLocalSet2(items: LocalStorageItems2) {
	return await browser.storage.local.set(serialize(LocalStorageItems2, items))
}

export async function browserStorageLocalGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems> {
	return LocalStorageItems.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}
export async function browserStorageLocalSafeParseGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems | undefined> {
	const parsed = LocalStorageItems.safeParse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
	if (parsed.success) return parsed.value
	return undefined
}

export async function browserStorageLocalRemove(keys: LocalStorageKey | LocalStorageKey[]) {
	return await browser.storage.local.remove(Array.isArray(keys) ? keys : [keys])
}
export async function browserStorageLocalSet(items: LocalStorageItems) {
	return await browser.storage.local.set(serialize(LocalStorageItems, items))
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
	await browser.storage.local.set({ [getTabStateKey(tabId)]: serialize(TabState, tabState) })
}
export const removeTabStateFromStorage = async (tabId: number) => await browser.storage.local.remove(getTabStateKey(tabId))

import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumAddressOrMissing, LiteralConverterParserFactory, serialize } from '../types/wire-types.js'
import { PendingChainChangeConfirmationPromise, RpcConnectionStatus, TabState } from '../types/user-interface-types.js'
import { CompleteVisualizedSimulation, EthereumSubscriptionsAndFilters } from '../types/visualizer-types.js'
import { AddressBookEntries, AddressBookEntry, ContactEntries, EntrySource } from '../types/addressBookTypes.js'
import { Page } from '../types/exportedSettingsTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { SignerName } from '../types/signerTypes.js'
import { PendingAccessRequests, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { UnexpectedErrorOccured } from '../types/interceptor-messages.js'

type IdsOfOpenedTabs = funtypes.Static<typeof IdsOfOpenedTabs>
const IdsOfOpenedTabs = funtypes.ReadonlyObject({
	addressBook: funtypes.Union(funtypes.Undefined, funtypes.Number),
	settingsView: funtypes.Union(funtypes.Undefined, funtypes.Number),
})

export type PartialIdsOfOpenedTabs = funtypes.Static<typeof PartialIdsOfOpenedTabs>
export const PartialIdsOfOpenedTabs = funtypes.ReadonlyPartial({
	addressBook: funtypes.Union(funtypes.Undefined, funtypes.Number),
	settingsView: funtypes.Union(funtypes.Undefined, funtypes.Number),
})

export type OldActiveAddressEntry = funtypes.Static<typeof OldActiveAddressEntry>
export const OldActiveAddressEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('activeAddress'),
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
	entrySource: EntrySource,
})

type LocalStorageItems = funtypes.Static<typeof LocalStorageItems>
const LocalStorageItems = funtypes.ReadonlyPartial({
	activeSigningAddress: EthereumAddressOrMissing,
	activeSimulationAddress: EthereumAddressOrMissing,
	addressInfos: AddressBookEntries,
	openedPageV2: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	currentRpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
	pendingInterceptorAccessRequests: PendingAccessRequests,
	contacts: ContactEntries,
	makeMeRich: funtypes.Boolean,
	pendingTransactionsAndMessages: funtypes.ReadonlyArray(PendingTransactionOrSignableMessage),
	ChainChangeConfirmationPromise: funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise),
	simulationResults: funtypes.Union(funtypes.Undefined, CompleteVisualizedSimulation),
	signerName: SignerName,
	currentTabId: funtypes.Union(funtypes.Undefined, funtypes.Number),
	rpcConnectionStatus: RpcConnectionStatus,
	ethereumSubscriptionsAndFilters: EthereumSubscriptionsAndFilters,
	useTabsInsteadOfPopup: funtypes.Boolean,
	rpcEntries: RpcEntries,
	metamaskCompatibilityMode: funtypes.Boolean,
	userAddressBookEntries: funtypes.ReadonlyArray(funtypes.Union(AddressBookEntry, OldActiveAddressEntry)),
	userAddressBookEntriesV2: AddressBookEntries,
	idsOfOpenedTabs: IdsOfOpenedTabs,
	interceptorDisabled: funtypes.Boolean,
	interceptorStartSleepingTimestamp: funtypes.Number,
	latestUnexpectedError: UnexpectedErrorOccured,
})

type LocalStorageKey = funtypes.Static<typeof LocalStorageKey>
const LocalStorageKey = funtypes.Union(
	funtypes.Literal('activeSigningAddress'),
	funtypes.Literal('activeSimulationAddress'),
	funtypes.Literal('addressInfos'),
	funtypes.Literal('openedPageV2'),
	funtypes.Literal('useSignersAddressAsActiveAddress'),
	funtypes.Literal('websiteAccess'),
	funtypes.Literal('currentRpcNetwork'),
	funtypes.Literal('simulationMode'),
	funtypes.Literal('pendingInterceptorAccessRequests'),
	funtypes.Literal('contacts'),
	funtypes.Literal('makeMeRich'),
	funtypes.Literal('pendingTransactionsAndMessages'),
	funtypes.Literal('ChainChangeConfirmationPromise'),
	funtypes.Literal('simulationResults'),
	funtypes.Literal('signerName'),
	funtypes.Literal('currentTabId'),
	funtypes.Literal('rpcConnectionStatus'),
	funtypes.Literal('ethereumSubscriptionsAndFilters'),
	funtypes.Literal('useTabsInsteadOfPopup'),
	funtypes.Literal('rpcEntries'),
	funtypes.Literal('metamaskCompatibilityMode'),
	funtypes.Literal('userAddressBookEntries'),
	funtypes.Literal('userAddressBookEntriesV2'),
	funtypes.Literal('idsOfOpenedTabs'),
	funtypes.Literal('interceptorStartSleepingTimestamp'),
	funtypes.Literal('latestUnexpectedError'),
)

export async function browserStorageLocalGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems> {
	return LocalStorageItems.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}
export async function browserStorageLocalRemove(keys: LocalStorageKey | LocalStorageKey[]) {
	return await browser.storage.local.remove(Array.isArray(keys) ? keys : [keys])
}

export async function browserStorageLocalSet(items: LocalStorageItems) {
	return await browser.storage.local.set(serialize(LocalStorageItems, items))
}

const getTabStateKey = (tabId: number): `tabState_${ number }` => `tabState_${ tabId }`

type TabStateItems = funtypes.Static<typeof TabStateItems>
const TabStateItems = funtypes.Record(funtypes.String, TabState)

export async function getTabStateFromStorage(tabId: number) {
	return TabStateItems.parse(await browser.storage.local.get(getTabStateKey(tabId)))?.[getTabStateKey(tabId)] ?? undefined
}
export async function setTabStateToStorage(tabId: number, tabState: TabState) {
	await browser.storage.local.set({ [getTabStateKey(tabId)]: serialize(TabState, tabState) })
}
export const removeTabStateFromStorage = async (tabId: number) => await browser.storage.local.remove(getTabStateKey(tabId))

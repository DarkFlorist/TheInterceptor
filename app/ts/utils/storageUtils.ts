import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumAddressOrMissing, LiteralConverterParserFactory, serialize } from '../types/wire-types.js'
import { PendingChainChangeConfirmationPromise, RpcConnectionStatus, TabState } from '../types/user-interface-types.js'
import { CompleteVisualizedSimulation, EthereumSubscriptionsAndFilters } from '../types/visualizer-types.js'
import { AddressBookEntries, AddressBookEntry, EntrySource } from '../types/addressBookTypes.js'
import { Page } from '../types/exportedSettingsTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { SignerName } from '../types/signerTypes.js'
import { PendingAccessRequests, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { UnexpectedErrorOccured } from '../types/interceptor-messages.js'
import { ENSLabelHashes, ENSNameHashes } from '../types/ens.js'

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
	openedPageV2: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	currentRpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
	pendingInterceptorAccessRequests: PendingAccessRequests,
	makeMeRich: funtypes.Boolean,
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
	ensNameHashes: ENSNameHashes,
	ensLabelHashes: ENSLabelHashes,
})

type LocalStorageKey = funtypes.Static<typeof LocalStorageKey>
const LocalStorageKey = funtypes.Union(
	funtypes.Literal('activeSigningAddress'),
	funtypes.Literal('activeSimulationAddress'),
	funtypes.Literal('openedPageV2'),
	funtypes.Literal('useSignersAddressAsActiveAddress'),
	funtypes.Literal('websiteAccess'),
	funtypes.Literal('currentRpcNetwork'),
	funtypes.Literal('simulationMode'),
	funtypes.Literal('pendingInterceptorAccessRequests'),
	funtypes.Literal('makeMeRich'),
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
	funtypes.Literal('ensNameHashes'),
	funtypes.Literal('ensLabelHashes'),
)

type LocalStorageItems2 = funtypes.Static<typeof LocalStorageItems2>
const LocalStorageItems2 = funtypes.ReadonlyPartial({
	pendingTransactionsAndMessages: funtypes.ReadonlyArray(PendingTransactionOrSignableMessage)
})

type LocalStorageKey2 = funtypes.Static<typeof LocalStorageKey2>
const LocalStorageKey2 = funtypes.Union(
	funtypes.Literal('pendingTransactionsAndMessages'),
)

// these methods are split to 1 and 2 to make the funtypes types simpler
export async function browserStorageLocalGet2(keys: LocalStorageKey2 | LocalStorageKey2[]): Promise<LocalStorageItems2> {
	return LocalStorageItems2.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}
export async function browserStorageLocalRemove2(keys: LocalStorageKey2 | LocalStorageKey2[]) {
	return await browser.storage.local.remove(Array.isArray(keys) ? keys : [keys])
}
export async function browserStorageLocalSet2(items: LocalStorageItems2) {
	return await browser.storage.local.set(serialize(LocalStorageItems2, items))
}

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
export const TabStateItems = funtypes.Record(funtypes.String, TabState)

export async function getTabStateFromStorage(tabId: number) {
	return TabStateItems.parse(await browser.storage.local.get(getTabStateKey(tabId)))?.[getTabStateKey(tabId)] ?? undefined
}
export async function setTabStateToStorage(tabId: number, tabState: TabState) {
	await browser.storage.local.set({ [getTabStateKey(tabId)]: serialize(TabState, tabState) })
}
export const removeTabStateFromStorage = async (tabId: number) => await browser.storage.local.remove(getTabStateKey(tabId))

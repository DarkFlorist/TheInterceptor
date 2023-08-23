import * as funtypes from 'funtypes'
import { EthereumAddressOrMissing } from './wire-types.js'
import { AddressBookEntries, AddressInfoArray, ContactEntries, SignerName } from './user-interface-types.js'
import { Page, PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingPersonalSignPromise, PendingTransaction, RpcConnectionStatus, TabState, WebsiteAccessArray } from './interceptor-messages.js'
import { EthereumSubscriptions, RpcEntries, RpcNetwork, SimulationResults } from './visualizer-types.js'

export type LocalStorageItems = funtypes.Static<typeof LocalStorageItems>
export const LocalStorageItems = funtypes.Partial({
	activeSigningAddress: EthereumAddressOrMissing,
	activeSimulationAddress: EthereumAddressOrMissing,
	addressInfos: AddressInfoArray,
	page: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	rpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
	pendingInterceptorAccessRequests: PendingAccessRequestArray,
	contacts: ContactEntries,
	makeMeRich: funtypes.Boolean,
	addressbookTabId: funtypes.Union(funtypes.Undefined, funtypes.Number),
	transactionsPendingForUserConfirmation: funtypes.ReadonlyArray(PendingTransaction),
	ChainChangeConfirmationPromise: funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise),
	PersonalSignPromise: funtypes.Union(funtypes.Undefined, PendingPersonalSignPromise),
	simulationResults: funtypes.Union(funtypes.Undefined, SimulationResults),
	signerName: SignerName,
	currentTabId: funtypes.Union(funtypes.Undefined, funtypes.Number),
	rpcConnectionStatus: RpcConnectionStatus,
	ethereumSubscriptions: EthereumSubscriptions,
	useTabsInsteadOfPopup: funtypes.Boolean,
	RpcEntries: RpcEntries,
	metamaskCompatibilityMode: funtypes.Boolean,
	userAddressBookEntries: AddressBookEntries,
})

export type LocalStorageKey = funtypes.Static<typeof LocalStorageKey>
export const LocalStorageKey = funtypes.Union(
	funtypes.Literal('activeSigningAddress'),
	funtypes.Literal('activeSimulationAddress'),
	funtypes.Literal('addressInfos'),
	funtypes.Literal('page'),
	funtypes.Literal('useSignersAddressAsActiveAddress'),
	funtypes.Literal('websiteAccess'),
	funtypes.Literal('rpcNetwork'),
	funtypes.Literal('simulationMode'),
	funtypes.Literal('pendingInterceptorAccessRequests'),
	funtypes.Literal('contacts'),
	funtypes.Literal('makeMeRich'),
	funtypes.Literal('addressbookTabId'),
	funtypes.Literal('transactionsPendingForUserConfirmation'),
	funtypes.Literal('ChainChangeConfirmationPromise'),
	funtypes.Literal('PersonalSignPromise'),
	funtypes.Literal('simulationResults'),
	funtypes.Literal('signerName'),
	funtypes.Literal('currentTabId'),
	funtypes.Literal('rpcConnectionStatus'),
	funtypes.Literal('ethereumSubscriptions'),
	funtypes.Literal('useTabsInsteadOfPopup'),
	funtypes.Literal('RpcEntries'),
	funtypes.Literal('metamaskCompatibilityMode'),
	funtypes.Literal('userAddressBookEntries'),
)

export async function browserStorageLocalGet(keys: LocalStorageKey | LocalStorageKey[]): Promise<LocalStorageItems> {
	return LocalStorageItems.parse(await browser.storage.local.get(Array.isArray(keys) ? keys : [keys]))
}
export async function browserStorageLocalRemove(keys: LocalStorageKey | LocalStorageKey[]) {
	return await browser.storage.local.remove(Array.isArray(keys) ? keys : [keys])
}

export async function browserStorageLocalSet(items: LocalStorageItems) {
	return await browser.storage.local.set(LocalStorageItems.serialize(items) as { [key: string]: unknown } )
}

const getTabStateKey = (tabId: number): `tabState_${ number }` => `tabState_${ tabId }`

type TabStateItems = funtypes.Static<typeof TabStateItems>
const TabStateItems = funtypes.Record(funtypes.String, TabState)

export async function getTabStateFromStorage(tabId: number) {
	return TabStateItems.parse(await browser.storage.local.get(getTabStateKey(tabId)))?.[getTabStateKey(tabId)] ?? undefined
}
export async function setTabStateFromStorage(tabId: number, tabState: TabState) {
	await browser.storage.local.set({ [getTabStateKey(tabId)]: TabState.serialize(tabState) })
}
export const removeTabStateFromStorage = async (tabId: number) => await browser.storage.local.remove(getTabStateKey(tabId))

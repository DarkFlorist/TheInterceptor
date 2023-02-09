import { MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { AddressBookTabIdSetting } from '../utils/interceptor-messages.js'
import { AddressInfo, ContactEntries, Page, PendingAccessRequestArray } from '../utils/user-interface-types.js'
import { EthereumAddress, EthereumQuantity } from '../utils/wire-types.js'
import * as funtypes from 'funtypes'

export const defaultAddresses = [
	{
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
	},
	{
		name: 'Public private key',
		address: MOCK_PRIVATE_KEYS_ADDRESS,
		askForAddressAccess: false,
	}
]

export type WebsiteAddressAccess = funtypes.Static<typeof WebsiteAddressAccess>
export const WebsiteAddressAccess = funtypes.Object({
	address: EthereumAddress,
	access: funtypes.Boolean,
}).asReadonly()

export type WebsiteAccess = funtypes.Static<typeof WebsiteAccess>
export const WebsiteAccess = funtypes.Object({
	origin: funtypes.String,
	originIcon: funtypes.Union(funtypes.String, funtypes.Undefined),
	access: funtypes.Boolean,
	addressAccess: funtypes.Union(funtypes.ReadonlyArray(WebsiteAddressAccess), funtypes.Undefined),
}).asReadonly()

export type WebsiteAccessArray = funtypes.Static<typeof WebsiteAccessArray>
export const WebsiteAccessArray = funtypes.ReadonlyArray(WebsiteAccess)

export interface Settings {
	activeSimulationAddress: EthereumAddress | undefined,
	activeSigningAddress: EthereumAddress | undefined,
	activeChain: EthereumQuantity,
	addressInfos: readonly AddressInfo[],
	page: Page,
	makeMeRich: boolean,
	useSignersAddressAsActiveAddress: boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: boolean,
	pendingAccessRequests: PendingAccessRequestArray,
	contacts: ContactEntries,
}

export async function getSettings() : Promise<Settings> {
	const isEmpty = (obj: Object) => { return Object.keys(obj).length === 0 }
	const results = await browser.storage.local.get([
		'activeSigningAddress',
		'activeSimulationAddress',
		'addressInfos',
		'page',
		'makeMeRich',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'activeChain',
		'simulationMode',
		'pendingAccessRequests',
		'contacts',
	])
	console.log(results)
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined && !isEmpty(results.activeSimulationAddress) ? EthereumAddress.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		activeSigningAddress: results.activeSigningAddress !== undefined && !isEmpty(results.activeSigningAddress) ? EthereumAddress.parse(results.activeSigningAddress) : undefined,
		addressInfos: results.addressInfos !== undefined && !isEmpty(results.addressInfos) ? results.addressInfos.map( (x: AddressInfo) => AddressInfo.parse(x)) : defaultAddresses,
		page: results.page !== undefined && !isEmpty(results.page) ? parseInt(results.page) : Page.Home,
		makeMeRich: results.makeMeRich !== undefined ? results.makeMeRich : false,
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress !== undefined ? results.useSignersAddressAsActiveAddress : false,
		websiteAccess: WebsiteAccessArray.parse(results.websiteAccess !== undefined ? results.websiteAccess : []),
		activeChain: results.activeChain !== undefined ? EthereumQuantity.parse(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? results.simulationMode : true,
		pendingAccessRequests: PendingAccessRequestArray.parse(results.pendingAccessRequests !== undefined ? results.pendingAccessRequests : []),
		contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
	}
}

export function saveActiveSimulationAddress(activeSimulationAddress: bigint | undefined) {
	return browser.storage.local.set({ activeSimulationAddress: activeSimulationAddress ? EthereumAddress.serialize(activeSimulationAddress) : undefined})
}
export function saveActiveSigningAddress(activeSigningAddress: bigint | undefined) {
	return browser.storage.local.set({ activeSigningAddress: activeSigningAddress ? EthereumAddress.serialize(activeSigningAddress) : undefined})
}

export function saveAddressInfos(addressInfos: readonly AddressInfo[]) {
	browser.storage.local.set({ addressInfos: addressInfos.map( (x) => AddressInfo.serialize(x) ) })
}
export function savePage(page: Page) {
	browser.storage.local.set({ page: page })
}
export function saveMakeMeRich(makeMeRich: boolean) {
	browser.storage.local.set({ makeMeRich: makeMeRich })
}
export function saveUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean) {
	browser.storage.local.set({ useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress })
}
export function saveWebsiteAccess(websiteAccess: WebsiteAccessArray) {
	browser.storage.local.set({ websiteAccess: WebsiteAccessArray.serialize(websiteAccess) })
}
export function saveActiveChain(activeChain: EthereumQuantity) {
	browser.storage.local.set({ activeChain: EthereumQuantity.serialize(activeChain) })
}
export function saveSimulationMode(simulationMode: boolean) {
	browser.storage.local.set({ simulationMode: simulationMode })
}
export function savePendingAccessRequests(pendingAccessRequests: PendingAccessRequestArray) {
	browser.storage.local.set({ pendingAccessRequests: PendingAccessRequestArray.serialize(pendingAccessRequests) })
}
export function saveOpenedAddressBookTabId(addressbookTabId: number) {
	browser.storage.local.set({ addressbookTabId: addressbookTabId })
}

export async function getOpenedAddressBookTabId() {
	const tabIdData = await browser.storage.local.get(['addressbookTabId'])
	if (!AddressBookTabIdSetting.test(tabIdData)) return undefined
	return AddressBookTabIdSetting.parse(tabIdData).addressbookTabId
}

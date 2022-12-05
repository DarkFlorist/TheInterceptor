import { AddressInfo, Page, PendingAccessRequest } from '../utils/user-interface-types'
import { EthereumAddress, EthereumQuantity } from '../utils/wire-types'

export const defaultAddresses = [
	{
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
	}
]

export interface WebsiteAddressAccess {
	address: string,
	access: boolean
} []

export interface WebsiteAccess {
	origin: string,
	originIcon: string | undefined,
	access: boolean,
	addressAccess: readonly WebsiteAddressAccess[] | undefined,
}

export interface Settings {
	activeSimulationAddress: EthereumAddress | undefined,
	activeSigningAddress: EthereumAddress | undefined,
	activeChain: EthereumQuantity,
	addressInfos: readonly AddressInfo[],
	page: Page,
	makeMeRich: boolean,
	useSignersAddressAsActiveAddress: boolean,
	websiteAccess: readonly WebsiteAccess[],
	simulationMode: boolean,
	pendingAccessRequests: readonly PendingAccessRequest[]
}

function parseActiveChain(chain: string) {
	// backwards compatible as the chain used to be a string
	if (chain === 'Ethereum Mainnet') return 1n
	if (chain === 'Goerli') return 5n
	return EthereumQuantity.parse(chain)
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
	])
	console.log(results)
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined && !isEmpty(results.activeSimulationAddress) ? EthereumAddress.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		activeSigningAddress: results.activeSigningAddress !== undefined && !isEmpty(results.activeSigningAddress) ? EthereumAddress.parse(results.activeSigningAddress) : undefined,
		addressInfos: results.addressInfos !== undefined && !isEmpty(results.addressInfos) ? results.addressInfos.map( (x: AddressInfo) => AddressInfo.parse(x)) : defaultAddresses,
		page: results.page !== undefined && !isEmpty(results.page) ? parseInt(results.page) : Page.Home,
		makeMeRich: results.makeMeRich !== undefined ? results.makeMeRich : false,
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress !== undefined ? results.useSignersAddressAsActiveAddress : false,
		websiteAccess: results.websiteAccess !== undefined ? results.websiteAccess : [],
		activeChain: results.activeChain !== undefined ? parseActiveChain(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? results.simulationMode : true,
		pendingAccessRequests: results.pendingAccessRequests !== undefined ? results.pendingAccessRequests : [],
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
export function saveWebsiteAccess(websiteAccess: readonly WebsiteAccess[]) {
	browser.storage.local.set({ websiteAccess: websiteAccess })
}
export function saveActiveChain(activeChain: EthereumQuantity) {
	browser.storage.local.set({ activeChain: EthereumQuantity.serialize(activeChain) })
}
export function saveSimulationMode(simulationMode: boolean) {
	browser.storage.local.set({ simulationMode: simulationMode })
}
export function savePendingAccessRequests(pendingAccessRequests: readonly PendingAccessRequest[]) {
	browser.storage.local.set({ pendingAccessRequests: pendingAccessRequests })
}

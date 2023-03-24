import { MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { AddressBookTabIdSetting, LegacyWebsiteAccessArray, Page, PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingInterceptorAccessRequestPromise, PendingPersonalSignPromise, PendingUserRequestPromise, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy, pages } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet } from '../utils/typescript.js'
import { AddressInfo, ContactEntries } from '../utils/user-interface-types.js'
import { SimulationResults } from '../utils/visualizer-types.js'
import { EthereumAddress, EthereumQuantity } from '../utils/wire-types.js'

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

function parseAccessWithLegacySupport(data: unknown): WebsiteAccessArray {
	const parsed = WebsiteAccessArrayWithLegacy.parse(data)
	if (parsed.length === 0) return []
	if ('origin' in parsed[0]) {
		const legacy = LegacyWebsiteAccessArray.parse(data)
		return legacy.map((x) => ({
			access: x.access,
			addressAccess: x.addressAccess,
			website: {
				websiteOrigin: x.origin,
				icon: x.originIcon,
				title: undefined,
			},
		}))
	}
	return WebsiteAccessArray.parse(data)
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
		page: results.page !== undefined && !isEmpty(results.page) && pages.includes(results.page) ? results.page : 'Home',
		makeMeRich: results.makeMeRich !== undefined ? results.makeMeRich : false,
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress !== undefined ? results.useSignersAddressAsActiveAddress : false,
		websiteAccess: results.websiteAccess !== undefined ? parseAccessWithLegacySupport(results.websiteAccess) : [],
		activeChain: results.activeChain !== undefined ? EthereumQuantity.parse(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? results.simulationMode : true,
		pendingAccessRequests: PendingAccessRequestArray.parse(results.pendingAccessRequests !== undefined ? results.pendingAccessRequests : []),
		userAddressBook: {
			addressInfos: results.addressInfos !== undefined && !isEmpty(results.addressInfos) ? results.addressInfos.map( (x: AddressInfo) => AddressInfo.parse(x)) : defaultAddresses,
			contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
		}
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
export function saveContacts(contacts: ContactEntries) {
	browser.storage.local.set({ contacts: ContactEntries.serialize(contacts) })
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

export async function getConfirmationWindowPromise(): Promise<PendingUserRequestPromise | undefined> {
	const results = await browser.storage.local.get(['ConfirmationWindowPromise'])
	return results.ConfirmationWindowPromise === undefined ? undefined : PendingUserRequestPromise.parse(results.ConfirmationWindowPromise)
}

export async function saveConfirmationWindowPromise(promise: PendingUserRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('ConfirmationWindowPromise')
	}
	return await browser.storage.local.set({ ConfirmationWindowPromise: PendingUserRequestPromise.serialize(promise) })
}

export async function getChainChangeConfirmationPromise(): Promise<PendingChainChangeConfirmationPromise | undefined> {
	const results = await browser.storage.local.get(['ChainChangeConfirmationPromise'])
	return results.ChainChangeConfirmationPromise === undefined ? undefined : PendingChainChangeConfirmationPromise.parse(results.ChainChangeConfirmationPromise)
}

export async function saveChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('ChainChangeConfirmationPromise')
	}
	return await browser.storage.local.set({ ChainChangeConfirmationPromise: PendingChainChangeConfirmationPromise.serialize(promise) })
}

export async function getPendingPersonalSignPromise(): Promise<PendingPersonalSignPromise | undefined> {
	const results = await browser.storage.local.get(['PersonalSignPromise'])
	return results.PersonalSignPromise === undefined ? undefined : PendingPersonalSignPromise.parse(results.PersonalSignPromise)
}

export async function savePendingPersonalSignPromise(promise: PendingPersonalSignPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('PersonalSignPromise')
	}
	return await browser.storage.local.set({ PersonalSignPromise: PendingPersonalSignPromise.serialize(promise) })
}

export async function getPendingInterceptorAccessRequestPromise(): Promise<PendingInterceptorAccessRequestPromise | undefined> {
	const results = await browser.storage.local.get(['InterceptorAccessRequestPromise'])
	return results.InterceptorAccessRequestPromise === undefined ? undefined : PendingInterceptorAccessRequestPromise.parse(results.InterceptorAccessRequestPromise)
}

export async function savePendingInterceptorAccessRequestPromise(promise: PendingInterceptorAccessRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('InterceptorAccessRequestPromise')
	}
	return await browser.storage.local.set({ InterceptorAccessRequestPromise: PendingInterceptorAccessRequestPromise.serialize(promise) })
}

const SIMULATION_RESULTS_STORAGE_KEY = 'simulationResults'
export async function getSimulationResults() {
	const results = await browserStorageLocalGet(['simulationResults'])
	if (results.simulationResults === undefined) {
		return {
			simulationId: 0,
			simulationState: undefined,
			visualizerResults: undefined,
			addressBookEntries: [],
			tokenPrices: [],
			activeAddress: undefined
		}
	}
	return SimulationResults.parse(results.simulationResults)
}

const simulationResultsSemaphore = new Semaphore(1)
export async function updateSimulationResults(newResults: SimulationResults) {
	simulationResultsSemaphore.execute(async () => {
		const oldResults = await getSimulationResults()
		// TODO: use funtypes to parse/validate `results` here.  `browser.storage.local.get` returns an `any` I think (which is terrible)
		if (newResults.simulationId < oldResults.simulationId) return // do not update state with older state
		return await browser.storage.local.set({ [SIMULATION_RESULTS_STORAGE_KEY]: SimulationResults.serialize(newResults) })
	})
}

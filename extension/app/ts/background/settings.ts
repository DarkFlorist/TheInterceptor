import { ICON_NOT_ACTIVE, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { AddressBookTabIdSetting, LegacyWebsiteAccessArray, Page, PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingInterceptorAccessRequestPromise, PendingPersonalSignPromise, PendingUserRequestPromise, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy, SignerName, TabState } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/typescript.js'
import { AddressInfo, AddressInfoArray, ContactEntries } from '../utils/user-interface-types.js'
import { SimulationResults } from '../utils/visualizer-types.js'
import { EthereumAddressOrUndefined, EthereumQuantity } from '../utils/wire-types.js'
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
	const results = await browserStorageLocalGet([
		'activeSigningAddress',
		'activeSimulationAddress',
		'addressInfos',
		'page',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'activeChain',
		'simulationMode',
		'pendingAccessRequests',
		'contacts',
	])
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined ? EthereumAddressOrUndefined.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		activeSigningAddress: results.activeSigningAddress !== undefined ? EthereumAddressOrUndefined.parse(results.activeSigningAddress) : undefined,
		page: results.page !== undefined ? Page.parse(results.page) : 'Home',
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress !== undefined ? funtypes.Boolean.parse(results.useSignersAddressAsActiveAddress) : false,
		websiteAccess: results.websiteAccess !== undefined ? parseAccessWithLegacySupport(results.websiteAccess) : [],
		activeChain: results.activeChain !== undefined ? EthereumQuantity.parse(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? funtypes.Boolean.parse(results.simulationMode) : true,
		pendingAccessRequests: PendingAccessRequestArray.parse(results.pendingAccessRequests !== undefined ? results.pendingAccessRequests : []),
		userAddressBook: {
			addressInfos: results.addressInfos !== undefined ? AddressInfoArray.parse(results.addressInfos): defaultAddresses,
			contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
		}
	}
}

export function saveActiveSimulationAddress(activeSimulationAddress: bigint | undefined) {
	return browserStorageLocalSet({ activeSimulationAddress: EthereumAddressOrUndefined.serialize(activeSimulationAddress) as string })
}
export function saveActiveSigningAddress(activeSigningAddress: bigint | undefined) {
	return browserStorageLocalSet({ activeSigningAddress: EthereumAddressOrUndefined.serialize(activeSigningAddress) as string })
}

export function saveAddressInfos(addressInfos: readonly AddressInfo[]) {
	browserStorageLocalSet({ addressInfos: addressInfos.map( (x) => AddressInfo.serialize(x) as string ) })
}
export function saveContacts(contacts: ContactEntries) {
	browserStorageLocalSet({ contacts: ContactEntries.serialize(contacts) as string })
}
export function savePage(page: Page) {
	browserStorageLocalSet({ page: page })
}
export async function saveMakeMeRich(makeMeRich: boolean) {
	await browserStorageLocalSet({ makeMeRich: makeMeRich })
}
export async function getMakeMeRich() {
	const results = await browserStorageLocalGet('makeMeRich')
	return funtypes.Boolean.parse(results.makeMeRich !== undefined ? results.makeMeRich : false)
}
export function saveUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean) {
	browserStorageLocalSet({ useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress })
}
export function saveWebsiteAccess(websiteAccess: WebsiteAccessArray) {
	browserStorageLocalSet({ websiteAccess: WebsiteAccessArray.serialize(websiteAccess) as string })
}
export function saveActiveChain(activeChain: EthereumQuantity) {
	browserStorageLocalSet({ activeChain: EthereumQuantity.serialize(activeChain) as string })
}
export function saveSimulationMode(simulationMode: boolean) {
	browserStorageLocalSet({ simulationMode: simulationMode })
}
export function savePendingAccessRequests(pendingAccessRequests: PendingAccessRequestArray) {
	browserStorageLocalSet({ pendingAccessRequests: PendingAccessRequestArray.serialize(pendingAccessRequests) as string })
}
export function saveOpenedAddressBookTabId(addressbookTabId: number) {
	browserStorageLocalSet({ addressbookTabId: addressbookTabId })
}

export async function getOpenedAddressBookTabId() {
	const tabIdData = await browserStorageLocalGet(['addressbookTabId'])
	if (!AddressBookTabIdSetting.test(tabIdData)) return undefined
	return AddressBookTabIdSetting.parse(tabIdData).addressbookTabId
}

export async function getConfirmationWindowPromise(): Promise<PendingUserRequestPromise | undefined> {
	const results = await browserStorageLocalGet(['ConfirmationWindowPromise'])
	return results.ConfirmationWindowPromise === undefined ? undefined : PendingUserRequestPromise.parse(results.ConfirmationWindowPromise)
}

export async function saveConfirmationWindowPromise(promise: PendingUserRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('ConfirmationWindowPromise')
	}
	return await browserStorageLocalSet({ ConfirmationWindowPromise: PendingUserRequestPromise.serialize(promise) as string })
}

export async function getChainChangeConfirmationPromise(): Promise<PendingChainChangeConfirmationPromise | undefined> {
	const results = await browserStorageLocalGet(['ChainChangeConfirmationPromise'])
	return results.ChainChangeConfirmationPromise === undefined ? undefined : PendingChainChangeConfirmationPromise.parse(results.ChainChangeConfirmationPromise)
}

export async function saveChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('ChainChangeConfirmationPromise')
	}
	return await browserStorageLocalSet({ ChainChangeConfirmationPromise: PendingChainChangeConfirmationPromise.serialize(promise) as string })
}

export async function getPendingPersonalSignPromise(): Promise<PendingPersonalSignPromise | undefined> {
	const results = await browserStorageLocalGet(['PersonalSignPromise'])
	return results.PersonalSignPromise === undefined ? undefined : PendingPersonalSignPromise.parse(results.PersonalSignPromise)
}

export async function savePendingPersonalSignPromise(promise: PendingPersonalSignPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('PersonalSignPromise')
	}
	return await browserStorageLocalSet({ PersonalSignPromise: PendingPersonalSignPromise.serialize(promise) as string })
}

export async function getPendingInterceptorAccessRequestPromise(): Promise<PendingInterceptorAccessRequestPromise | undefined> {
	const results = await browserStorageLocalGet(['InterceptorAccessRequestPromise'])
	return results.InterceptorAccessRequestPromise === undefined ? undefined : PendingInterceptorAccessRequestPromise.parse(results.InterceptorAccessRequestPromise)
}

export async function savePendingInterceptorAccessRequestPromise(promise: PendingInterceptorAccessRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('InterceptorAccessRequestPromise')
	}
	return await browserStorageLocalSet({ InterceptorAccessRequestPromise: PendingInterceptorAccessRequestPromise.serialize(promise) as string })
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
		if (newResults.simulationId < oldResults.simulationId) return // do not update state with older state
		return await browserStorageLocalSet({ [SIMULATION_RESULTS_STORAGE_KEY]: SimulationResults.serialize(newResults) as string  })
	})
}

export async function saveSignerName(signerName: SignerName) {
	return await browserStorageLocalSet({ signerName: signerName })
}

export async function getSignerName() {
	const results = await browserStorageLocalGet(['signerName'])
	if (results.signerName !== undefined) {
		return SignerName.parse(results.signerName)
	}
	return 'NoSignerDetected'
}

export async function getTabState(tabId: Number) : Promise<TabState> {
	const name = `tabState_${ tabId }`
	const results = await browserStorageLocalGet([name])
	if (results[name] !== undefined) {
		return TabState.parse(results[name])
	}
	return {
		signerName: 'NoSigner',
		signerAccounts: [],
		signerChain: undefined,
		tabIconDetails: {
			icon: ICON_NOT_ACTIVE,
			iconReason: 'No active address selected.',
		}
	}
}
export async function saveTabState(tabId: Number, tabState: TabState) {
	const name = `tabState_${ tabId }`
	return await browserStorageLocalSet({ [name]: TabState.serialize(tabState) as string })
}

export async function removeTabState(tabId: Number) {
	const name = `tabState_${ tabId }`
	await browser.storage.local.remove(name)
}

export async function clearTabStates() {
	const allStorage = Object.keys(await browser.storage.local.get())
	const keysToRemove = allStorage.filter((entry) => entry.match(/^tabState_[0-9]+/))
	await browser.storage.local.remove(keysToRemove)
}

const tabStateSemaphore = new Semaphore(1)
export async function updateTabState(tabId: Number, updateFunc: (prevTabState: TabState) => Promise<TabState>) {
	tabStateSemaphore.execute(async () => {
		await saveTabState(tabId, await updateFunc(await getTabState(tabId)))
	})
}

import { ICON_NOT_ACTIVE, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { LegacyWebsiteAccessArray, Page, PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingInterceptorAccessRequestPromise, PendingPersonalSignPromise, PendingUserRequestPromise, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy, SignerName, TabState } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSingleGetWithDefault } from '../utils/typescript.js'
import { AddressInfoArray, ContactEntries } from '../utils/user-interface-types.js'
import { SimulationResults } from '../utils/visualizer-types.js'
import { EthereumAddress, EthereumAddressOrUndefined, EthereumQuantity } from '../utils/wire-types.js'
import * as funtypes from 'funtypes'

const storageName = {
	activeSigningAddress: 'activeSigningAddress',
	activeSimulationAddress: 'activeSimulationAddress',
	addressInfos: 'addressInfos',
	page: 'page',
	useSignersAddressAsActiveAddress: 'useSignersAddressAsActiveAddress',
	websiteAccess: 'websiteAccess',
	activeChain: 'activeChain',
	simulationMode: 'simulationMode',
	pendingAccessRequests: 'pendingAccessRequests',
	contacts: 'contacts',
	makeMeRich: 'makeMeRich',
	addressbookTabId: 'addressbookTabId',
	ConfirmationWindowPromise: 'ConfirmationWindowPromise',
	ChainChangeConfirmationPromise: 'ChainChangeConfirmationPromise',
	PersonalSignPromise: 'PersonalSignPromise',
	InterceptorAccessRequestPromise: 'InterceptorAccessRequestPromise',
	simulationResults: 'simulationResults',
	signerName: 'signerName',
}

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
		storageName.activeSigningAddress,
		storageName.activeSimulationAddress,
		storageName.addressInfos,
		storageName.page,
		storageName.useSignersAddressAsActiveAddress,
		storageName.websiteAccess,
		storageName.activeChain,
		storageName.simulationMode,
		storageName.pendingAccessRequests,
		storageName.contacts,
	])
	const useSignersAddressAsActiveAddress = results.useSignersAddressAsActiveAddress !== undefined ? funtypes.Boolean.parse(results.useSignersAddressAsActiveAddress) : false
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined ? EthereumAddress.parse(results.activeSimulationAddress) : (useSignersAddressAsActiveAddress ? undefined : defaultAddresses[0].address),
		activeSigningAddress: EthereumAddressOrUndefined.parse(results.activeSigningAddress),
		page: results.page !== undefined ? Page.parse(results.page) : 'Home',
		useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress,
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

export async function setActiveSimulationAddress(activeSimulationAddress: bigint | undefined) {
	if (activeSimulationAddress === undefined) return await browser.storage.local.remove(storageName.activeSimulationAddress)
	return browserStorageLocalSet(storageName.activeSimulationAddress, EthereumAddress.serialize(activeSimulationAddress) as string)
}
export async function setActiveSigningAddress(activeSigningAddress: bigint | undefined) {
	if (activeSigningAddress === undefined) return await browser.storage.local.remove(storageName.activeSigningAddress)
	return browserStorageLocalSet(storageName.activeSigningAddress, EthereumAddress.serialize(activeSigningAddress) as string)
}

export async function setPage(page: Page) {
	return browserStorageLocalSet(storageName.page, page)
}
export async function setMakeMeRich(makeMeRich: boolean) {
	await browserStorageLocalSet(storageName.makeMeRich, makeMeRich)
}
export async function getMakeMeRich() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault(storageName.makeMeRich, false))
}
export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean) {
	return browserStorageLocalSet(storageName.useSignersAddressAsActiveAddress, useSignersAddressAsActiveAddress)
}

export async function setActiveChain(activeChain: EthereumQuantity) {
	return browserStorageLocalSet(storageName.activeChain, EthereumQuantity.serialize(activeChain) as string)
}
export async function setSimulationMode(simulationMode: boolean) {
	return browserStorageLocalSet(storageName.simulationMode, simulationMode)
}

export async function setOpenedAddressBookTabId(addressbookTabId: number) {
	return browserStorageLocalSet(storageName.addressbookTabId, addressbookTabId)
}

export async function getOpenedAddressBookTabId() {
	const tabIdData = await browserStorageLocalSingleGetWithDefault(storageName.addressbookTabId, undefined)
	return funtypes.Union(funtypes.Undefined, funtypes.Number).parse(tabIdData)
}

export async function getConfirmationWindowPromise(): Promise<PendingUserRequestPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault(storageName.ConfirmationWindowPromise, undefined)
	return funtypes.Union(funtypes.Undefined, PendingUserRequestPromise).parse(results)
}

export async function setConfirmationWindowPromise(promise: PendingUserRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove(storageName.ConfirmationWindowPromise)
	}
	return await browserStorageLocalSet(storageName.ConfirmationWindowPromise, PendingUserRequestPromise.serialize(promise) as string)
}

export async function getChainChangeConfirmationPromise(): Promise<PendingChainChangeConfirmationPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault(storageName.ChainChangeConfirmationPromise, undefined)
	return funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise).parse(results)
}

export async function setChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove(storageName.ChainChangeConfirmationPromise)
	}
	return await browserStorageLocalSet(storageName.ChainChangeConfirmationPromise, PendingChainChangeConfirmationPromise.serialize(promise) as string)
}

export async function getPendingPersonalSignPromise(): Promise<PendingPersonalSignPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault(storageName.PersonalSignPromise, undefined)
	return funtypes.Union(funtypes.Undefined, PendingPersonalSignPromise).parse(results)
}

export async function setPendingPersonalSignPromise(promise: PendingPersonalSignPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove(storageName.PersonalSignPromise)
	}
	return await browserStorageLocalSet(storageName.PersonalSignPromise, PendingPersonalSignPromise.serialize(promise) as string)
}

export async function getPendingInterceptorAccessRequestPromise(): Promise<PendingInterceptorAccessRequestPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault(storageName.InterceptorAccessRequestPromise, undefined)
	return funtypes.Union(funtypes.Undefined, PendingInterceptorAccessRequestPromise).parse(results)
}

export async function setPendingInterceptorAccessRequestPromise(promise: PendingInterceptorAccessRequestPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove(storageName.InterceptorAccessRequestPromise)
	}
	return await browserStorageLocalSet(storageName.InterceptorAccessRequestPromise, PendingInterceptorAccessRequestPromise.serialize(promise) as string)
}

export async function getSimulationResults() {
	const results = await browserStorageLocalSingleGetWithDefault(storageName.simulationResults, undefined)
	const parsed = funtypes.Union(funtypes.Undefined, SimulationResults).parse(results)
	if (parsed === undefined) {
		return {
			simulationId: 0,
			simulationState: undefined,
			visualizerResults: undefined,
			addressBookEntries: [],
			tokenPrices: [],
			activeAddress: undefined
		}
	}
	return parsed
}

const simulationResultsSemaphore = new Semaphore(1)
export async function updateSimulationResults(newResults: SimulationResults) {
	await simulationResultsSemaphore.execute(async () => {
		const oldResults = await getSimulationResults()
		if (newResults.simulationId < oldResults.simulationId) return // do not update state with older state
		return await browserStorageLocalSet(storageName.simulationResults, SimulationResults.serialize(newResults) as string)
	})
}

export async function setSignerName(signerName: SignerName) {
	return await browserStorageLocalSet(storageName.signerName, signerName)
}

export async function getSignerName() {
	return SignerName.parse(await browserStorageLocalSingleGetWithDefault(storageName.signerName, 'NoSignerDetected'))
}

export async function getTabState(tabId: Number) : Promise<TabState> {
	const name = `tabState_${ tabId }`
	const results = await browserStorageLocalSingleGetWithDefault(name, undefined)
	const parsed = funtypes.Union(funtypes.Undefined, TabState).parse(results)
	if (parsed !== undefined) return parsed
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
export async function setTabState(tabId: Number, tabState: TabState) {
	const name = `tabState_${ tabId }`
	return await browserStorageLocalSet(name, TabState.serialize(tabState) as string)
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
export async function updateTabState(tabId: Number, updateFunc: (prevState: TabState) => Promise<TabState>) {
	await tabStateSemaphore.execute(async () => {
		await setTabState(tabId, await updateFunc(await getTabState(tabId)))
	})
}

const pendingAccessRequestsSemaphore = new Semaphore(1)
export async function updatePendingAccessRequests(updateFunc: (prevState: PendingAccessRequestArray) => PendingAccessRequestArray) {
	await pendingAccessRequestsSemaphore.execute(async () => {
		const pendingAccessRequests = PendingAccessRequestArray.parse(await browserStorageLocalSingleGetWithDefault(storageName.pendingAccessRequests, []))
		return browserStorageLocalSet(storageName.pendingAccessRequests, PendingAccessRequestArray.serialize(updateFunc(pendingAccessRequests)) as string)
	})
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const websiteAccess = WebsiteAccessArray.parse(await browserStorageLocalSingleGetWithDefault(storageName.websiteAccess, []))
		return browserStorageLocalSet(storageName.websiteAccess, WebsiteAccessArray.serialize(updateFunc(websiteAccess)) as string)
	})
}

const addressInfosSemaphore = new Semaphore(1)
export async function updateAddressInfos(updateFunc: (prevState: AddressInfoArray) => AddressInfoArray) {
	await addressInfosSemaphore.execute(async () => {
		const addressInfos = AddressInfoArray.parse(await browserStorageLocalSingleGetWithDefault(storageName.addressInfos, AddressInfoArray.serialize(defaultAddresses)))
		return browserStorageLocalSet(storageName.addressInfos, AddressInfoArray.serialize(updateFunc(addressInfos)) as string)
	})
}

const contactsSemaphore = new Semaphore(1)
export async function updateContacts(updateFunc: (prevState: ContactEntries) => ContactEntries) {
	await contactsSemaphore.execute(async () => {
		const contacts = ContactEntries.parse(await browserStorageLocalSingleGetWithDefault(storageName.contacts, []))
		return browserStorageLocalSet(storageName.contacts, ContactEntries.serialize(updateFunc(contacts)) as string)
	})
}

import { ICON_NOT_ACTIVE, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { LegacyWebsiteAccessArray, Page, PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingPersonalSignPromise, PendingTransaction, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy, TabState, IsConnected, PendingAccessRequest } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSetKeys, browserStorageLocalSingleGetWithDefault } from '../utils/storageUtils.js'
import { AddressInfoArray, ContactEntries, SignerName } from '../utils/user-interface-types.js'
import { EthereumSubscriptions, SimulationResults } from '../utils/visualizer-types.js'
import { EthereumAddress, EthereumAddressOrMissing, EthereumQuantity } from '../utils/wire-types.js'
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
		'contacts',
	])
	const useSignersAddressAsActiveAddress = results.useSignersAddressAsActiveAddress !== undefined ? funtypes.Boolean.parse(results.useSignersAddressAsActiveAddress) : false
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined ? EthereumAddressOrMissing.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		activeSigningAddress: results.activeSigningAddress === undefined ? undefined : EthereumAddressOrMissing.parse(results.activeSigningAddress),
		page: results.page !== undefined ? Page.parse(results.page) : 'Home',
		useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress,
		websiteAccess: results.websiteAccess !== undefined ? parseAccessWithLegacySupport(results.websiteAccess) : [],
		activeChain: results.activeChain !== undefined ? EthereumQuantity.parse(results.activeChain) : 1n,
		simulationMode: results.simulationMode !== undefined ? funtypes.Boolean.parse(results.simulationMode) : true,
		userAddressBook: {
			addressInfos: results.addressInfos !== undefined ? AddressInfoArray.parse(results.addressInfos): defaultAddresses,
			contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
		}
	}
}

export async function setPage(page: Page) {
	return await browserStorageLocalSet('page', page)
}
export async function setMakeMeRich(makeMeRich: boolean) {
	return await browserStorageLocalSet('makeMeRich', makeMeRich)
}
export async function getMakeMeRich() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('makeMeRich', false))
}
export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean) {
	return await browserStorageLocalSet('useSignersAddressAsActiveAddress', useSignersAddressAsActiveAddress)
}

export async function setOpenedAddressBookTabId(addressbookTabId: number) {
	return await browserStorageLocalSet('addressbookTabId', addressbookTabId)
}

export async function changeSimulationMode(changes: { simulationMode: boolean, activeChain?: EthereumQuantity, activeSimulationAddress?: EthereumAddress | undefined, activeSigningAddress?: EthereumAddress | undefined }) {
	return await browserStorageLocalSetKeys({
		simulationMode: changes.simulationMode,
		...changes.activeChain ? { activeChain: EthereumQuantity.serialize(changes.activeChain) as string }: {},
		...'activeSimulationAddress' in changes ? { activeSimulationAddress: EthereumAddressOrMissing.serialize(changes.activeSimulationAddress) as string }: {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: EthereumAddressOrMissing.serialize(changes.activeSigningAddress) as string }: {},
	})
}

export async function getOpenedAddressBookTabId() {
	const tabIdData = await browserStorageLocalSingleGetWithDefault('addressbookTabId', undefined)
	return funtypes.Union(funtypes.Undefined, funtypes.Number).parse(tabIdData)
}

export async function getPendingTransactions(): Promise<readonly PendingTransaction[]> {
	const results = await browserStorageLocalSingleGetWithDefault('transactionsPendingForUserConfirmation', [])
	return funtypes.ReadonlyArray(PendingTransaction).parse(results)
}

const pendingTransactionsSemaphore = new Semaphore(1)
export async function clearPendingTransactions() {
	return await pendingTransactionsSemaphore.execute(async () => {
		return await browserStorageLocalSet('transactionsPendingForUserConfirmation', funtypes.ReadonlyArray(PendingTransaction).serialize([]) as string)
	})
}
export async function appendPendingTransaction(promise: PendingTransaction) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const promises = [...await getPendingTransactions(), promise]
		await browserStorageLocalSet('transactionsPendingForUserConfirmation', funtypes.ReadonlyArray(PendingTransaction).serialize(promises) as string)
		return promises
	})
}
export async function removePendingTransaction(requestId: number) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const promises = await getPendingTransactions()
		const foundPromise = promises.find((promise) => promise.request.requestId === requestId)
		if (foundPromise !== undefined) {
			const filteredPromises = promises.filter((promise) => promise.request.requestId !== requestId)
			await browserStorageLocalSet('transactionsPendingForUserConfirmation', funtypes.ReadonlyArray(PendingTransaction).serialize(filteredPromises) as string)
		}
		return foundPromise
	})
}

export async function getChainChangeConfirmationPromise(): Promise<PendingChainChangeConfirmationPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault('ChainChangeConfirmationPromise', undefined)
	return funtypes.Union(funtypes.Undefined, PendingChainChangeConfirmationPromise).parse(results)
}

export async function setChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('ChainChangeConfirmationPromise')
	}
	return await browserStorageLocalSet('ChainChangeConfirmationPromise', PendingChainChangeConfirmationPromise.serialize(promise) as string)
}

export async function getPendingPersonalSignPromise(): Promise<PendingPersonalSignPromise | undefined> {
	const results = await browserStorageLocalSingleGetWithDefault('PersonalSignPromise', undefined)
	return funtypes.Union(funtypes.Undefined, PendingPersonalSignPromise).parse(results)
}

export async function setPendingPersonalSignPromise(promise: PendingPersonalSignPromise | undefined) {
	if (promise === undefined) {
		return await browser.storage.local.remove('PersonalSignPromise')
	}
	return await browserStorageLocalSet('PersonalSignPromise', PendingPersonalSignPromise.serialize(promise) as string)
}

export async function getSimulationResults() {
	const results = await browserStorageLocalSingleGetWithDefault('simulationResults', undefined)
	const emptyResults = {
		simulationId: 0,
		simulationState: undefined,
		visualizerResults: undefined,
		addressBookEntries: [],
		tokenPrices: [],
		activeAddress: undefined
	}
	try {
		const parsed = funtypes.Union(funtypes.Undefined, SimulationResults).parse(results)
		if (parsed === undefined) return emptyResults
		return parsed
	} catch (error) {
		console.warn(error)
		return emptyResults
	}
}

const simulationResultsSemaphore = new Semaphore(1)
export async function updateSimulationResults(newResults: SimulationResults) {
	await simulationResultsSemaphore.execute(async () => {
		const oldResults = await getSimulationResults()
		if (newResults.simulationId < oldResults.simulationId) return // do not update state with older state
		return await browserStorageLocalSet('simulationResults', SimulationResults.serialize(newResults) as string)
	})
}

export async function setSignerName(signerName: SignerName) {
	return await browserStorageLocalSet('signerName', signerName)
}

export async function getSignerName() {
	return SignerName.parse(await browserStorageLocalSingleGetWithDefault('signerName', 'NoSignerDetected'))
}

const getTabStateKey = (tabId: number): `tabState_${ number }` => `tabState_${ tabId }`

export async function getTabState(tabId: number) : Promise<TabState> {
	const results = await browserStorageLocalSingleGetWithDefault(getTabStateKey(tabId), undefined)
	const parsed = funtypes.Union(funtypes.Undefined, TabState).parse(results)
	if (parsed !== undefined) return parsed
	return {
		signerName: 'NoSigner',
		signerAccounts: [],
		signerChain: undefined,
		tabIconDetails: {
			icon: ICON_NOT_ACTIVE,
			iconReason: 'No active address selected.',
		},
	}
}
export async function setTabState(tabId: number, tabState: TabState) {
	return await browserStorageLocalSet(getTabStateKey(tabId), TabState.serialize(tabState) as string)
}

export async function removeTabState(tabId: number) {
	await browser.storage.local.remove(getTabStateKey(tabId))
}

export async function clearTabStates() {
	const allStorage = Object.keys(await browser.storage.local.get())
	const keysToRemove = allStorage.filter((entry) => entry.match(/^tabState_[0-9]+/))
	await browser.storage.local.remove(keysToRemove)
}

const tabStateSemaphore = new Semaphore(1)
export async function updateTabState(tabId: number, updateFunc: (prevState: TabState) => TabState) {
	await tabStateSemaphore.execute(async () => {
		await setTabState(tabId, updateFunc(await getTabState(tabId)))
	})
}

const pendingAccessRequestsSemaphore = new Semaphore(1)
export async function updatePendingAccessRequests(updateFunc: (prevState: PendingAccessRequestArray) => Promise<PendingAccessRequestArray>) {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const pendingAccessRequests = await updateFunc(PendingAccessRequestArray.parse(await browserStorageLocalSingleGetWithDefault('pendingInterceptorAccessRequests', [])))
		await browserStorageLocalSet('pendingInterceptorAccessRequests', PendingAccessRequestArray.serialize(pendingAccessRequests) as string)
		return pendingAccessRequests
	})
}
export async function getPendingAccessRequests() {
	return PendingAccessRequestArray.parse(await browserStorageLocalSingleGetWithDefault('pendingInterceptorAccessRequests', []))
}
export async function appendPendingAccessRequests(promise: PendingAccessRequest) {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const promises = [...await getPendingAccessRequests(), promise]
		await browserStorageLocalSet('pendingInterceptorAccessRequests', PendingAccessRequestArray.serialize(promises) as string)
		return promises
	})
}

export async function clearPendingAccessRequests() {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const pending = getPendingAccessRequests()
		await browserStorageLocalSet('pendingInterceptorAccessRequests', PendingAccessRequestArray.serialize([]) as string)
		return pending
	})
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const websiteAccess = WebsiteAccessArray.parse(await browserStorageLocalSingleGetWithDefault('websiteAccess', []))
		return await browserStorageLocalSet('websiteAccess', WebsiteAccessArray.serialize(updateFunc(websiteAccess)) as string)
	})
}

const addressInfosSemaphore = new Semaphore(1)
export async function updateAddressInfos(updateFunc: (prevState: AddressInfoArray) => AddressInfoArray) {
	await addressInfosSemaphore.execute(async () => {
		const addressInfos = AddressInfoArray.parse(await browserStorageLocalSingleGetWithDefault('addressInfos', AddressInfoArray.serialize(defaultAddresses)))
		return await browserStorageLocalSet('addressInfos', AddressInfoArray.serialize(updateFunc(addressInfos)) as string)
	})
}

const contactsSemaphore = new Semaphore(1)
export async function updateContacts(updateFunc: (prevState: ContactEntries) => ContactEntries) {
	await contactsSemaphore.execute(async () => {
		const contacts = ContactEntries.parse(await browserStorageLocalSingleGetWithDefault('contacts', []))
		return await browserStorageLocalSet('contacts', ContactEntries.serialize(updateFunc(contacts)) as string)
	})
}

export async function saveCurrentTabId(tabId: number) {
	return browserStorageLocalSet('currentTabId', tabId)
}

export async function getCurrentTabId() {
	return funtypes.Union(funtypes.Undefined, funtypes.Number).parse(await browserStorageLocalSingleGetWithDefault('currentTabId', undefined))
}

export async function setIsConnected(isConnected: boolean) {
	return await browserStorageLocalSet('isConnectedToNode', IsConnected.serialize({ isConnected, lastConnnectionAttempt: Date.now() }) as string )
}

export async function getIsConnected() {
	return IsConnected.parse(await browserStorageLocalSingleGetWithDefault('isConnectedToNode', undefined))
}

export async function getEthereumSubscriptions() {
	return EthereumSubscriptions.parse(await browserStorageLocalSingleGetWithDefault('ethereumSubscriptions', []))
}

const ethereumSubscriptionsSemaphore = new Semaphore(1)
export async function updateEthereumSubscriptions(updateFunc: (prevState: EthereumSubscriptions) => EthereumSubscriptions) {
	await ethereumSubscriptionsSemaphore.execute(async () => {
		const subscriptions = EthereumSubscriptions.parse(await browserStorageLocalSingleGetWithDefault('ethereumSubscriptions', []))
		return await browserStorageLocalSet('ethereumSubscriptions', EthereumSubscriptions.serialize(updateFunc(subscriptions)) as string)
	})
}

export async function getUseTabsInsteadOfPopup() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('useTabsInsteadOfPopup', false))
}

export async function setUseTabsInsteadOfPopup(useTabsInsteadOfPopup: boolean) {
	return await browserStorageLocalSet('useTabsInsteadOfPopup', funtypes.Boolean.serialize(useTabsInsteadOfPopup) as string)
}

import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import { PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingPersonalSignPromise, PendingTransaction, TabState, IsConnected, PendingAccessRequest } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet, browserStorageLocalSingleGetWithDefault } from '../utils/storageUtils.js'
import { SignerName } from '../utils/user-interface-types.js'
import { EthereumSubscriptions, SimulationResults } from '../utils/visualizer-types.js'
import * as funtypes from 'funtypes'

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

export async function setOpenedAddressBookTabId(addressbookTabId: number) {
	return await browserStorageLocalSet('addressbookTabId', addressbookTabId)
}

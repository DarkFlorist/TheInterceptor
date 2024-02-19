import { DEFAULT_TAB_CONNECTION, getChainName } from '../utils/constants.js'
import { Semaphore } from '../utils/semaphore.js'
import { PendingChainChangeConfirmationPromise, PendingPersonalSignPromise, RpcConnectionStatus, TabState } from '../types/user-interface-types.js'
import { PartialIdsOfOpenedTabs, browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSet, getTabStateFromStorage, removeTabStateFromStorage, setTabStateToStorage } from '../utils/storageUtils.js'
import { CompleteVisualizedSimulation, EthereumSubscriptionsAndFilters } from '../types/visualizer-types.js'
import { defaultRpcs, getSettings } from './settings.js'
import { UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { SignerName } from '../types/signerTypes.js'
import { PendingAccessRequest, PendingAccessRequests, PendingTransaction } from '../types/accessRequest.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'

export const getIdsOfOpenedTabs = async () => (await browserStorageLocalGet('idsOfOpenedTabs'))?.['idsOfOpenedTabs'] ?? { settingsView: undefined, addressBook: undefined}
export const setIdsOfOpenedTabs = async (ids: PartialIdsOfOpenedTabs) => await browserStorageLocalSet({ idsOfOpenedTabs: { ...await getIdsOfOpenedTabs(), ...ids } })

export async function getPendingTransactions(): Promise<readonly PendingTransaction[]> {
	try {
		return (await browserStorageLocalGet('transactionsPendingForUserConfirmation'))?.['transactionsPendingForUserConfirmation'] ?? []
	} catch(e) {
		console.warn('Pending transactions were corrupt:')
		console.warn(e)
		return []
	}
}

const pendingTransactionsSemaphore = new Semaphore(1)
export async function clearPendingTransactions() {
	return await pendingTransactionsSemaphore.execute(async () => {
		return await browserStorageLocalSet({ transactionsPendingForUserConfirmation: [] })
	})
}
export async function appendPendingTransaction(pendingTransaction: PendingTransaction) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const pendingTransactions = [...await getPendingTransactions(), pendingTransaction]
		await browserStorageLocalSet({ transactionsPendingForUserConfirmation: pendingTransactions })
		return pendingTransactions
	})
}

export async function replacePendingTransaction(pendingTransaction: PendingTransaction) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const pendingTransactions = await getPendingTransactions()
		const match = pendingTransactions.findIndex((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, pendingTransaction.uniqueRequestIdentifier))
		if (match < 0) return undefined
		const replaced = replaceElementInReadonlyArray(pendingTransactions, match, pendingTransaction)
		await browserStorageLocalSet({ transactionsPendingForUserConfirmation: replaced })
		return pendingTransaction
	})
}

export async function removePendingTransaction(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const promises = await getPendingTransactions()
		const foundPromise = promises.find((promise) => doesUniqueRequestIdentifiersMatch(promise.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (foundPromise !== undefined) {
			const filteredPromises = promises.filter((promise) => !doesUniqueRequestIdentifiersMatch(promise.uniqueRequestIdentifier, uniqueRequestIdentifier))
			await browserStorageLocalSet({ transactionsPendingForUserConfirmation: filteredPromises })
		}
		return foundPromise
	})
}

export const getChainChangeConfirmationPromise = async() => (await browserStorageLocalGet('ChainChangeConfirmationPromise'))?.['ChainChangeConfirmationPromise'] ?? undefined
export async function setChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) return await browserStorageLocalRemove('ChainChangeConfirmationPromise')
	return await browserStorageLocalSet({ ChainChangeConfirmationPromise: promise })
}

export const getPendingPersonalSignPromise = async() => (await browserStorageLocalGet('PersonalSignPromise'))?.['PersonalSignPromise'] ?? undefined
export async function setPendingPersonalSignPromise(promise: PendingPersonalSignPromise | undefined) {
	if (promise === undefined) return await browserStorageLocalRemove('PersonalSignPromise')
	return await browserStorageLocalSet({ PersonalSignPromise: promise })
}

export async function getSimulationResults() {
	const emptyResults = {
		simulationUpdatingState: 'done' as const,
		simulationResultState: 'invalid' as const,
		simulationId: 0,
		simulationState: undefined,
		visualizerResults: [],
		addressBookEntries: [],
		tokenPrices: [],
		activeAddress: undefined,
		namedTokenIds: [],
		protectors: [],
		simulatedAndVisualizedTransactions: [],
		visualizedPersonalSignRequests: [],
	}
	try {
		return (await browserStorageLocalGet('simulationResults'))?.['simulationResults'] ?? emptyResults
	} catch (error) {
		console.warn('Simulation results were corrupt:')
		console.warn(error)
		return emptyResults
	}
}

const simulationResultsSemaphore = new Semaphore(1)
export async function updateSimulationResults(newResults: CompleteVisualizedSimulation) {
	return await simulationResultsSemaphore.execute(async () => {
		const oldResults = await getSimulationResults()
		if (newResults.simulationId < oldResults.simulationId) return oldResults // do not update state with older state
		await browserStorageLocalSet({ simulationResults: newResults })
		return newResults
	})
}

export async function updateSimulationResultsWithCallBack(update: (oldResults: CompleteVisualizedSimulation | undefined) => Promise<CompleteVisualizedSimulation | undefined>) {
	return await simulationResultsSemaphore.execute(async () => {
		const oldResults = await getSimulationResults()
		const newRequests = await update(oldResults)
		if (newRequests === undefined || newRequests.simulationId < oldResults.simulationId) return oldResults // do not update state with older state
		await browserStorageLocalSet({ simulationResults: newRequests })
		return newRequests
	})
}

export const setDefaultSignerName = async (signerName: SignerName) => await browserStorageLocalSet({ signerName })
export const getDefaultSignerName = async () => (await browserStorageLocalGet('signerName'))?.['signerName'] ?? 'NoSignerDetected'

export async function getTabState(tabId: number) : Promise<TabState> {
	return await getTabStateFromStorage(tabId) ?? {
		website: undefined,
		signerName: await getDefaultSignerName(),
		signerAccounts: [],
		signerChain: undefined,
		signerAccountError: undefined,
		tabIconDetails: DEFAULT_TAB_CONNECTION,
		activeSigningAddress: undefined
	}
}
export const removeTabState = async(tabId: number) => removeTabStateFromStorage(tabId)

export async function clearTabStates() {
	const allStorage = Object.keys(await browser.storage.local.get())
	const keysToRemove = allStorage.filter((entry) => entry.match(/^tabState_[0-9]+/) !== null)
	await browser.storage.local.remove(keysToRemove)
}

const tabStateSemaphore = new Semaphore(1)
export async function updateTabState(tabId: number, updateFunc: (prevState: TabState) => TabState) {
	return await tabStateSemaphore.execute(async () => {
		const previousState = await getTabState(tabId)
		const newState = updateFunc(previousState)
		await setTabStateToStorage(tabId, newState)
		return { previousState, newState }
	})
}

export const getPendingAccessRequests = async () => (await browserStorageLocalGet('pendingInterceptorAccessRequests'))?.['pendingInterceptorAccessRequests'] ?? []
const pendingAccessRequestsSemaphore = new Semaphore(1)
export async function updatePendingAccessRequests(updateFunc: (prevState: PendingAccessRequests) => Promise<PendingAccessRequests>) {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const previous = await getPendingAccessRequests()
		const pendingAccessRequests = await updateFunc(previous)
		await browserStorageLocalSet({ pendingInterceptorAccessRequests: pendingAccessRequests })
		return { previous: previous, current: pendingAccessRequests }
	})
}

export async function appendPendingAccessRequests(promise: PendingAccessRequest) {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const promises = [...await getPendingAccessRequests(), promise]
		await browserStorageLocalSet({ pendingInterceptorAccessRequests: promises })
		return promises
	})
}

export async function clearPendingAccessRequests() {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const pending = await getPendingAccessRequests()
		await browserStorageLocalSet({ pendingInterceptorAccessRequests: [] })
		return pending
	})
}

export const saveCurrentTabId = async (tabId: number) => browserStorageLocalSet({ currentTabId: tabId })
export const getCurrentTabId = async () => (await browserStorageLocalGet('currentTabId'))?.['currentTabId'] ?? undefined

export const setRpcConnectionStatus = async (rpcConnectionStatus: RpcConnectionStatus) => browserStorageLocalSet({ rpcConnectionStatus })

export async function getRpcConnectionStatus() {
	try {
		return (await browserStorageLocalGet('rpcConnectionStatus'))?.['rpcConnectionStatus'] ?? undefined
	} catch (e) {
		console.warn('Connection status was corrupt:')
		console.warn(e)
		return undefined
	}
}

export const getEthereumSubscriptionsAndFilters = async () => (await browserStorageLocalGet('ethereumSubscriptionsAndFilters'))?.['ethereumSubscriptionsAndFilters'] ?? []

const ethereumSubscriptionsSemaphore = new Semaphore(1)
export async function updateEthereumSubscriptionsAndFilters(updateFunc: (prevState: EthereumSubscriptionsAndFilters) => EthereumSubscriptionsAndFilters) {
	return await ethereumSubscriptionsSemaphore.execute(async () => {
		const oldSubscriptions = await getEthereumSubscriptionsAndFilters()
		const newSubscriptions = updateFunc(oldSubscriptions)
		await browserStorageLocalSet({ ethereumSubscriptionsAndFilters: newSubscriptions })
		return { oldSubscriptions, newSubscriptions }
	})
}

export const setRpcList = async(rpcEntries: RpcEntries) => await browserStorageLocalSet({ rpcEntries })

export async function getRpcList() {
	try {
		return (await browserStorageLocalGet('rpcEntries'))?.['rpcEntries'] ?? defaultRpcs
	} catch(e) {
		console.warn('Rpc entries were corrupt:')
		console.warn(e)
		return defaultRpcs
	}
}

export const getPrimaryRpcForChain = async (chainId: bigint) => {
	const rpcs = await getRpcList()
	return rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
}

export async function getRpcNetwork(): Promise<RpcNetwork> {
	return (await getSettings()).currentRpcNetwork
}

export const getRpcNetworkForChain = async (chainId: bigint): Promise<RpcNetwork> => {
	const rpcs = await getRpcList()
	const rpc = rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
	if (rpc !== undefined) return rpc
	return {
		chainId: chainId,
		currencyName: 'Ether?',
		currencyTicker: 'ETH?',
		name: getChainName(chainId),
		httpsRpc: undefined,
	}
}

//TODO, remove when we start to use multicall completely. Decide on what to do with WETH then
export const ethDonator = [{
		chainId: 1n,
		eth_donator: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn, // Kraken
	},
	{
		chainId: 5n,
		eth_donator: 0xf36F155486299eCAff2D4F5160ed5114C1f66000n, // Some Goerli validator
	},
	{
		chainId: 11155111n,
		eth_donator: 0xb21c33de1fab3fa15499c62b59fe0cc3250020d1n, // Richest address on Sepolia
	}
] as const

export function getEthDonator(chainId: bigint) {
	return ethDonator.find((rpc) => rpc.chainId === chainId)?.eth_donator
}

export const getUserAddressBookEntries = async () => (await browserStorageLocalGet('userAddressBookEntries'))?.['userAddressBookEntries'] ?? []

const userAddressBookEntriesSemaphore = new Semaphore(1)
export async function updateUserAddressBookEntries(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		return await browserStorageLocalSet({ userAddressBookEntries: updateFunc(entries) })
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		const existingEntry = entries.find((entry) => entry.address === newEntry.address)
		if (existingEntry !== undefined) return
		return await browserStorageLocalSet({ userAddressBookEntries: entries.concat(newEntry) })
	})
}

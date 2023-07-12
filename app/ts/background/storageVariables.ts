import { ICON_NOT_ACTIVE, getChainName } from '../utils/constants.js'
import { PendingAccessRequestArray, PendingChainChangeConfirmationPromise, PendingPersonalSignPromise, PendingTransaction, TabState, IsConnected, PendingAccessRequest } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet, browserStorageLocalSingleGetWithDefault } from '../utils/storageUtils.js'
import { SignerName } from '../utils/user-interface-types.js'
import { EthereumSubscriptions, SimulationResults, RpcEntries, RpcNetwork } from '../utils/visualizer-types.js'
import * as funtypes from 'funtypes'
import { defaultRpcs, getSettings } from './settings.js'
import { UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'

export async function getOpenedAddressBookTabId() {
	const tabIdData = await browserStorageLocalSingleGetWithDefault('addressbookTabId', undefined)
	return funtypes.Union(funtypes.Undefined, funtypes.Number).parse(tabIdData)
}

export async function getPendingTransactions(): Promise<readonly PendingTransaction[]> {
	const results = await browserStorageLocalSingleGetWithDefault('transactionsPendingForUserConfirmation', [])
	try {
		return funtypes.ReadonlyArray(PendingTransaction).parse(results)
	} catch(e) {
		console.warn('Pending transactions were corrupt:')
		console.warn(e)
		return []
	}
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
export async function removePendingTransaction(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const promises = await getPendingTransactions()
		const foundPromise = promises.find((promise) => doesUniqueRequestIdentifiersMatch(promise.request.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (foundPromise !== undefined) {
			const filteredPromises = promises.filter((promise) => !doesUniqueRequestIdentifiersMatch(promise.request.uniqueRequestIdentifier, uniqueRequestIdentifier))
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
		console.warn('Simulation results were corrupt:')
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
		activeSigningAddress: undefined
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
	return await tabStateSemaphore.execute(async () => {
		const previousState = await getTabState(tabId)
		const newState = updateFunc(previousState)
		await setTabState(tabId, newState)
		return { previousState, newState }
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
	return await ethereumSubscriptionsSemaphore.execute(async () => {
		const oldSubscriptions = EthereumSubscriptions.parse(await browserStorageLocalSingleGetWithDefault('ethereumSubscriptions', []))
		const newSubscriptions = updateFunc(oldSubscriptions)
		await browserStorageLocalSet('ethereumSubscriptions', EthereumSubscriptions.serialize(newSubscriptions) as string)
		return { oldSubscriptions, newSubscriptions }
	})
}

export async function setOpenedAddressBookTabId(addressbookTabId: number) {
	return await browserStorageLocalSet('addressbookTabId', addressbookTabId)
}

export async function setRpcList(entries: RpcEntries) {
	return await browserStorageLocalSet('RpcEntries', RpcEntries.serialize(entries) as string)
}

export async function getRpcList() {
	const entries = await browserStorageLocalSingleGetWithDefault('RpcEntries', undefined)
	if (entries === undefined) return defaultRpcs
	try { return RpcEntries.parse(entries) } catch(e) { return defaultRpcs }
}

export const getPrimaryRpcForChain = async (chainId: bigint) => {
	const rpcs = await getRpcList()
	return rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
}

export async function getRpcNetwork(): Promise<RpcNetwork> {
	return (await getSettings()).rpcNetwork
}

export const getRpcNetworkForChain = async (chainId: bigint): Promise<RpcNetwork> => {
	const rpcs = await getRpcList()
	const rpc =  rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
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

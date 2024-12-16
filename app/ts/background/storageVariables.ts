import { DEFAULT_TAB_CONNECTION, getChainName } from '../utils/constants.js'
import { Semaphore } from '../utils/semaphore.js'
import { PendingChainChangeConfirmationPromise, RpcConnectionStatus, TabState } from '../types/user-interface-types.js'
import { PartialIdsOfOpenedTabs, TabStateItems, browserStorageLocalGet, browserStorageLocalGet2, browserStorageLocalRemove, browserStorageLocalSet, browserStorageLocalSet2, getTabStateFromStorage, removeTabStateFromStorage, setTabStateToStorage } from '../utils/storageUtils.js'
import { CompleteVisualizedSimulation, EthereumSubscriptionsAndFilters, TransactionStack } from '../types/visualizer-types.js'
import { defaultActiveAddresses, defaultRpcs } from './settings.js'
import { UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { AddressBookEntries, AddressBookEntry, ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { SignerName } from '../types/signerTypes.js'
import { PendingAccessRequests, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { UnexpectedErrorOccured } from '../types/interceptor-messages.js'
import { isValidName, namehash } from 'ethers'
import { bytesToUnsigned } from '../utils/bigint.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { modifyObject } from '../utils/typescript.js'

export const getIdsOfOpenedTabs = async () => (await browserStorageLocalGet('idsOfOpenedTabs'))?.idsOfOpenedTabs ?? { settingsView: undefined, addressBook: undefined, websiteAccess: undefined }
export const setIdsOfOpenedTabs = async (ids: PartialIdsOfOpenedTabs) => await browserStorageLocalSet({ idsOfOpenedTabs: { ...await getIdsOfOpenedTabs(), ...ids } })

const pendingTransactionsSemaphore = new Semaphore(1)
export async function getPendingTransactionsAndMessages(): Promise<readonly PendingTransactionOrSignableMessage[]> {
	try {
		return (await browserStorageLocalGet2('pendingTransactionsAndMessages'))?.pendingTransactionsAndMessages ?? []
	} catch(e) {
		console.warn('Pending transactions were corrupt:')
		console.warn(e)
		await pendingTransactionsSemaphore.execute(async () => await browserStorageLocalSet2({ pendingTransactionsAndMessages: [] }))
		return []
	}
}

export const clearPendingTransactions = async () => await updatePendingTransactionOrMessages(async () => [])
async function updatePendingTransactionOrMessages(update: (pendingTransactionsOrMessages: readonly PendingTransactionOrSignableMessage[]) => Promise<readonly PendingTransactionOrSignableMessage[]>) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const pendingTransactionsAndMessages = await update(await getPendingTransactionsAndMessages())
		await browserStorageLocalSet2({ pendingTransactionsAndMessages })
	})
}

export async function updatePendingTransactionOrMessage(uniqueRequestIdentifier: UniqueRequestIdentifier, update: (pendingTransactionOrMessage: PendingTransactionOrSignableMessage) => Promise<PendingTransactionOrSignableMessage | undefined>) {
	await updatePendingTransactionOrMessages(async (pendingTransactionsOrMessages) => {
		const match = pendingTransactionsOrMessages.findIndex((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (match < 0) return pendingTransactionsOrMessages
		const found = pendingTransactionsOrMessages[match]
		if (found === undefined) return pendingTransactionsOrMessages
		const updated = await update(found)
		if (updated === undefined) return pendingTransactionsOrMessages
		return replaceElementInReadonlyArray(pendingTransactionsOrMessages, match, updated)
	})
}

export async function appendPendingTransactionOrMessage(pendingTransactionOrMessage: PendingTransactionOrSignableMessage) {
	await updatePendingTransactionOrMessages(async (pendingTransactionsOrMessages) => [...pendingTransactionsOrMessages, pendingTransactionOrMessage])
}

export async function removePendingTransactionOrMessage(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTransactionOrMessages(async (pendingTransactionsOrMessages) => {
		const foundPromise = pendingTransactionsOrMessages.find((pendingTransactionsOrMessages) => doesUniqueRequestIdentifiersMatch(pendingTransactionsOrMessages.uniqueRequestIdentifier, uniqueRequestIdentifier))
		if (foundPromise === undefined) return pendingTransactionsOrMessages
		return pendingTransactionsOrMessages.filter((pendingTransactionOrMessage) => !doesUniqueRequestIdentifiersMatch(pendingTransactionOrMessage.uniqueRequestIdentifier, uniqueRequestIdentifier))
	})
}

export const getChainChangeConfirmationPromise = async() => (await browserStorageLocalGet('ChainChangeConfirmationPromise'))?.ChainChangeConfirmationPromise ?? undefined
export async function setChainChangeConfirmationPromise(promise: PendingChainChangeConfirmationPromise | undefined) {
	if (promise === undefined) return await browserStorageLocalRemove('ChainChangeConfirmationPromise')
	return await browserStorageLocalSet({ ChainChangeConfirmationPromise: promise })
}

const simulationResultsSemaphore = new Semaphore(1)
export async function getSimulationResults() {
	const emptyResults = {
		simulationUpdatingState: 'done' as const,
		simulationResultState: 'corrupted' as const,
		simulationId: 0,
		simulationState: undefined,
		eventsForEachTransaction: [],
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		activeAddress: undefined,
		namedTokenIds: [],
		protectors: [],
		simulatedAndVisualizedTransactions: [],
		visualizedPersonalSignRequests: [],
		parsedInputData: [],
	}
	try {
		return (await browserStorageLocalGet('simulationResults'))?.simulationResults ?? emptyResults
	} catch (error) {
		console.warn('Simulation results were corrupt:')
		console.warn(error)
		await browserStorageLocalSet({ simulationResults: emptyResults })
		return emptyResults
	}
}

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
const getDefaultSignerName = async () => (await browserStorageLocalGet('signerName'))?.signerName ?? 'NoSignerDetected'

export async function getTabState(tabId: number) : Promise<TabState> {
	return await getTabStateFromStorage(tabId) ?? {
		tabId,
		website: undefined,
		signerConnected: false,
		signerName: await getDefaultSignerName(),
		signerAccounts: [],
		signerChain: undefined,
		signerAccountError: undefined,
		tabIconDetails: DEFAULT_TAB_CONNECTION,
		activeSigningAddress: undefined
	}
}
export const removeTabState = async(tabId: number) => await removeTabStateFromStorage(tabId)

const getTabAllStateKeys = async () => {
	const allStorage = Object.keys(await browser.storage.local.get())
	return allStorage.filter((entry) => entry.match(/^tabState_[0-9]+/) !== null)
}

export const clearTabStates = async () => await browser.storage.local.remove(await getTabAllStateKeys())
export const getAllTabStates = async () => Object.values(TabStateItems.parse(await browser.storage.local.get(await getTabAllStateKeys()))).filter((state): state is TabState => state !== undefined)

const tabStateSemaphore = new Semaphore(1)
export async function updateTabState(tabId: number, updateFunc: (prevState: TabState) => TabState) {
	return await tabStateSemaphore.execute(async () => {
		const previousState = await getTabState(tabId)
		const newState = updateFunc(previousState)
		await setTabStateToStorage(tabId, newState)
		return { previousState, newState }
	})
}

export const getPendingAccessRequests = async () => (await browserStorageLocalGet('pendingInterceptorAccessRequests'))?.pendingInterceptorAccessRequests ?? []
const pendingAccessRequestsSemaphore = new Semaphore(1)
export async function updatePendingAccessRequests(updateFunc: (prevState: PendingAccessRequests) => Promise<PendingAccessRequests>) {
	return await pendingAccessRequestsSemaphore.execute(async () => {
		const previous = await getPendingAccessRequests()
		const pendingAccessRequests = await updateFunc(previous)
		await browserStorageLocalSet({ pendingInterceptorAccessRequests: pendingAccessRequests })
		return { previous: previous, current: pendingAccessRequests }
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
export const getCurrentTabId = async () => (await browserStorageLocalGet('currentTabId'))?.currentTabId ?? undefined

export const setRpcConnectionStatus = async (rpcConnectionStatus: RpcConnectionStatus) => browserStorageLocalSet({ rpcConnectionStatus })

export async function getRpcConnectionStatus() {
	try {
		return (await browserStorageLocalGet('rpcConnectionStatus'))?.rpcConnectionStatus ?? undefined
	} catch (e) {
		console.warn('Connection status was corrupt:')
		console.warn(e)
		return undefined
	}
}

export const getEthereumSubscriptionsAndFilters = async () => (await browserStorageLocalGet('ethereumSubscriptionsAndFilters'))?.ethereumSubscriptionsAndFilters ?? []

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
		return (await browserStorageLocalGet('rpcEntries'))?.rpcEntries ?? defaultRpcs
	} catch(e) {
		console.warn('Rpc entries were corrupt:')
		console.warn(e)
		return defaultRpcs
	}
}

export const setInterceptorStartSleepingTimestamp = async(interceptorStartSleepingTimestamp: number) => await browserStorageLocalSet({ interceptorStartSleepingTimestamp })

export const getInterceptorStartSleepingTimestamp = async () => (await browserStorageLocalGet('interceptorStartSleepingTimestamp'))?.interceptorStartSleepingTimestamp ?? 0

export const promoteRpcAsPrimary = async (rpcNetwork: RpcNetwork) => {
	if (rpcNetwork.primary) return
	const rpcs = await getRpcList()
	await setRpcList(rpcs.map((rpc) => rpc.chainId === rpcNetwork.chainId ? modifyObject(rpc, { primary: rpc.httpsRpc === rpcNetwork.httpsRpc }) : rpc))
}

export const getPrimaryRpcForChain = async (chainId: bigint) => {
	const rpcs = await getRpcList()
	const primary = rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary)
	if (primary) return primary

	// no primary was found, try to find what ever we have for that chain id
	const nonPrimary = rpcs.find((rpc) => rpc.chainId === chainId)
	if (nonPrimary) return nonPrimary
	return undefined
}

export const getRpcNetworkForChain = async (chainId: bigint): Promise<RpcNetwork> => {
	const rpc = await getPrimaryRpcForChain(chainId)
	if (rpc !== undefined) return rpc
	return {
		chainId: chainId,
		currencyName: 'Ether?',
		currencyTicker: 'ETH?',
		name: getChainName(chainId),
		httpsRpc: undefined,
		primary: false,
		minimized: true,
	}
}
export const getUserAddressBookEntries = async () => (await browserStorageLocalGet('userAddressBookEntriesV3'))?.userAddressBookEntriesV3 ?? defaultActiveAddresses
export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => {
	const entries = (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
	// sort more precise entries first (one with accurate chain id)
	entries.sort((x, y) => {
		if (x.entrySource === 'OnChain' && y.entrySource !== 'OnChain') return 1
		if (x.entrySource !== 'OnChain' && y.entrySource === 'OnChain') return -1
		if (typeof x.chainId === 'bigint' && typeof y.chainId !== 'bigint') return -1
		if (typeof x.chainId !== 'bigint' && typeof y.chainId === 'bigint') return 1
		return 0
	})
	return entries
}

const userAddressBookEntriesSemaphore = new Semaphore(1)
export async function updateUserAddressBookEntries(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		return await browserStorageLocalSet({ userAddressBookEntriesV3: updateFunc(entries) })
	})
}

export async function updateUserAddressBookEntriesV2Old(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = (await browserStorageLocalGet('userAddressBookEntriesV2'))?.userAddressBookEntriesV2 ?? defaultActiveAddresses
		return await browserStorageLocalSet({ userAddressBookEntriesV2: updateFunc(entries) })
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		const existingEntry = entries.find((entry) => entry.address === newEntry.address && (entry.chainId || 1n) === (newEntry.chainId || 1n) )
		if (existingEntry !== undefined) return
		return await browserStorageLocalSet({ userAddressBookEntriesV3: entries.concat(newEntry) })
	})
}

export async function setLatestUnexpectedError(latestUnexpectedError: UnexpectedErrorOccured | undefined) {
	if (latestUnexpectedError === undefined) return await browserStorageLocalRemove('latestUnexpectedError')
	return await browserStorageLocalSet({ latestUnexpectedError })
}

export const getLatestUnexpectedError = async () => (await browserStorageLocalGet('latestUnexpectedError'))?.latestUnexpectedError

export const getEnsNodeHashes = async () => (await browserStorageLocalGet('ensNameHashes'))?.ensNameHashes ?? []

const ensNodeHashesSemaphore = new Semaphore(1)
export async function addEnsNodeHash(name: string) {
	if (!isValidName(name)) return
	const entry = { name, nameHash: BigInt(namehash(name)) }
	await ensNodeHashesSemaphore.execute(async () => {
		const oldEntries = await getEnsNodeHashes() || []
		if (oldEntries.find((old) => old.nameHash === entry.nameHash)) return
		return await browserStorageLocalSet({ ensNameHashes: [...oldEntries, entry] })
	})
}

export const getEnsLabelHashes = async () => (await browserStorageLocalGet('ensLabelHashes'))?.ensLabelHashes ?? []

const ensLabelHashesSemaphore = new Semaphore(1)
export async function addEnsLabelHash(label: string) {
	const entry = { label, labelHash: bytesToUnsigned(keccak_256(label)) }
	await ensLabelHashesSemaphore.execute(async () => {
		const oldEntries = await getEnsLabelHashes() || []
		if (oldEntries.find((old) => old.labelHash === entry.labelHash)) return
		return await browserStorageLocalSet({ ensLabelHashes: [...oldEntries, entry] })
	})
}

const transactionStackSemaphore = new Semaphore(1)
export const getTransactionStack = async () => (await browserStorageLocalGet('transactionStack'))?.transactionStack ?? { transactions: [], signedMessages: [] }
export async function updateTransactionStack(updateFunc: (prevStack: TransactionStack) => TransactionStack): Promise<TransactionStack> {
	return await transactionStackSemaphore.execute(async () => {
		const prevStack = await getTransactionStack()
		const transactionStack = updateFunc(prevStack)
		await browserStorageLocalSet({ transactionStack })
		return transactionStack
	})
}

import { DEFAULT_TAB_CONNECTION, getChainName } from '../utils/constants.js'
import { Semaphore } from '../utils/semaphore.js'
import type { PendingChainChangeConfirmationPromise, PendingFetchSimulationStackRequestPromise, RpcConnectionStatus, StoredWatchAssetRequest, TabState } from '../types/user-interface-types.js'
import { type PartialIdsOfOpenedTabs, browserStorageLocalGet, browserStorageLocalGet2, browserStorageLocalRemove, browserStorageLocalSet, browserStorageLocalSet2, getTabStateFromStorage, parseTabStateItems, removeTabStateFromStorage, setTabStateToStorage } from '../utils/storageUtils.js'
import { CompleteVisualizedSimulation, type EthereumSubscriptionsAndFilters, InterceptorTransactionStack, createPassthroughCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { browserStorageLocalSafeParseGet } from '../utils/storageUtils.js'
import { DEFAULT_ACTIVE_ADDRESSES, DEFAULT_RPCS } from '../config/defaults.js'
import { type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { AddressBookEntry, doAddressBookChainIdsMatch, LegacyErc20TokenEntry, type AddressBookEntries, type ChainIdWithUniversal } from '../types/addressBookTypes.js'
import type { SignerName } from '../types/signerTypes.js'
import type { PendingAccessRequests, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { keccak256, namehash, stringToBytes } from '../utils/ethereumPrimitives.js'
import { isValidEnsName } from '../utils/ens.js'
import { modifyObject } from '../utils/typescript.js'
import type { UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { getLargeStateValue, prepareLargeStateWrite, setLargeStateValue, setLargeStateValues } from '../utils/largeStateStore.js'
import type { InterceptorErrorDiagnostic } from '../types/errorDiagnostics.js'
import { SafeTransactionStacks } from '../types/safeTypes.js'
import { createStoredValueRepository } from '../utils/storedValue.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
export { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'

const reportCorruptStoredValue = (label: string) => async (error: unknown) => {
	console.warn(`${ label } was corrupt:`)
	console.warn(error)
}

const idsOfOpenedTabsRepository = createStoredValueRepository({
	read: async () => (await browserStorageLocalGet('idsOfOpenedTabs')).idsOfOpenedTabs,
	write: async (idsOfOpenedTabs) => { await browserStorageLocalSet({ idsOfOpenedTabs }) },
	getDefault: () => ({ settingsView: undefined, addressBook: undefined, websiteAccess: undefined, simulationStack: undefined }),
})

export const getIdsOfOpenedTabs = idsOfOpenedTabsRepository.get
export const setIdsOfOpenedTabs = async (ids: PartialIdsOfOpenedTabs) => { await idsOfOpenedTabsRepository.update((previous) => ({ ...previous, ...ids })) }

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

export const getChainChangeConfirmationPromise = async() => (await browserStorageLocalGet('chainChangeConfirmationPromise'))?.chainChangeConfirmationPromise ?? undefined
export async function setChainChangeConfirmationPromise(chainChangeConfirmationPromise: PendingChainChangeConfirmationPromise | undefined) {
	if (chainChangeConfirmationPromise === undefined) return await browserStorageLocalRemove('chainChangeConfirmationPromise')
	return await browserStorageLocalSet({ chainChangeConfirmationPromise })
}

export const getFetchSimulationStackRequestPromise = async() => (await browserStorageLocalGet('fetchSimulationStackRequestPromise'))?.fetchSimulationStackRequestPromise ?? undefined
export async function setFetchSimulationStackRequestPromise(fetchSimulationStackRequestPromise: PendingFetchSimulationStackRequestPromise | undefined) {
	if (fetchSimulationStackRequestPromise === undefined) return await browserStorageLocalRemove('fetchSimulationStackRequestPromise')
	return await browserStorageLocalSet({ fetchSimulationStackRequestPromise })
}

const pendingWatchAssetRequestsRepository = createStoredValueRepository<readonly StoredWatchAssetRequest[]>({
	read: async () => (await browserStorageLocalGet('pendingWatchAssetRequests')).pendingWatchAssetRequests,
	write: async (pendingWatchAssetRequests) => { await browserStorageLocalSet({ pendingWatchAssetRequests }) },
	getDefault: () => [],
})
export const getPendingWatchAssetRequests = pendingWatchAssetRequestsRepository.get
export async function updatePendingWatchAssetRequests(update: (requests: readonly StoredWatchAssetRequest[]) => readonly StoredWatchAssetRequest[]) {
	return (await pendingWatchAssetRequestsRepository.update(update)).current
}

const popupRefreshGenerationRepository = createStoredValueRepository({
	read: async () => (await browserStorageLocalGet('popupRefreshGeneration')).popupRefreshGeneration,
	write: async (popupRefreshGeneration) => { await browserStorageLocalSet({ popupRefreshGeneration }) },
	getDefault: () => 0,
})
export const getPopupRefreshGeneration = popupRefreshGenerationRepository.get
export const setPopupRefreshGeneration = popupRefreshGenerationRepository.set

const simulationResultsSemaphore = new Semaphore(1)
export async function getPopupVisualisationState() {
	const emptyResults = createPassthroughCompleteVisualizedSimulation()
	try {
		return await getLargeStateValue('popupVisualisation', CompleteVisualizedSimulation) ?? emptyResults
	} catch (error) {
		console.warn('Simulation results were corrupt:')
		console.warn(error)
		await setLargeStateValue('popupVisualisation', CompleteVisualizedSimulation, emptyResults)
		return emptyResults
	}
}

export const setPopupVisualisationState = async (newResults: CompleteVisualizedSimulation) => await updatePopupVisualisationWithCallBack(async () => newResults)

export async function updatePopupVisualisationWithCallBack(update: (oldResults: CompleteVisualizedSimulation) => Promise<CompleteVisualizedSimulation | undefined>) {
	return await simulationResultsSemaphore.execute(async () => {
		const oldResults = await getPopupVisualisationState()
		const newRequests = await update(oldResults)
		if (newRequests === undefined || newRequests.simulationId < oldResults.simulationId) return oldResults // do not update state with older state
		await setLargeStateValue('popupVisualisation', CompleteVisualizedSimulation, newRequests)
		return newRequests
	})
}

const defaultSignerNameRepository = createStoredValueRepository<SignerName>({
	read: async () => (await browserStorageLocalGet('signerName')).signerName,
	write: async (signerName) => { await browserStorageLocalSet({ signerName }) },
	getDefault: () => 'NoSignerDetected',
})
export const setDefaultSignerName = defaultSignerNameRepository.set
const getDefaultSignerName = defaultSignerNameRepository.get

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
	return allStorage.filter((entry) => /^tabState_[0-9]+$/.test(entry))
}

export const clearTabStates = async () => await browser.storage.local.remove(await getTabAllStateKeys())
export const getAllTabStates = async () => Object.values(parseTabStateItems(await browser.storage.local.get(await getTabAllStateKeys()))).filter((state): state is TabState => state !== undefined)

const tabStateSemaphore = new Semaphore(1)
export async function updateTabState(tabId: number, updateFunc: (prevState: TabState) => TabState) {
	return await tabStateSemaphore.execute(async () => {
		const previousState = await getTabState(tabId)
		const newState = updateFunc(previousState)
		await setTabStateToStorage(tabId, newState)
		return { previousState, newState }
	})
}

const pendingAccessRequestsRepository = createStoredValueRepository<PendingAccessRequests>({
	read: async () => (await browserStorageLocalGet('pendingInterceptorAccessRequests')).pendingInterceptorAccessRequests,
	write: async (pendingInterceptorAccessRequests) => { await browserStorageLocalSet({ pendingInterceptorAccessRequests }) },
	getDefault: () => [],
})
export const getPendingAccessRequests = pendingAccessRequestsRepository.get
export async function updatePendingAccessRequests(updateFunc: (prevState: PendingAccessRequests) => Promise<PendingAccessRequests>) {
	return await pendingAccessRequestsRepository.update(updateFunc)
}

export async function clearPendingAccessRequests() {
	return (await pendingAccessRequestsRepository.update(() => [])).previous
}

export const saveCurrentTabId = async (tabId: number) => browserStorageLocalSet({ currentTabId: tabId })
export const getCurrentTabId = async () => (await browserStorageLocalGet('currentTabId'))?.currentTabId ?? undefined

const rpcConnectionStatusRepository = createStoredValueRepository<RpcConnectionStatus>({
	read: async () => (await browserStorageLocalGet('rpcConnectionStatus')).rpcConnectionStatus,
	write: async (rpcConnectionStatus) => { await browserStorageLocalSet({ rpcConnectionStatus }) },
	getDefault: () => undefined,
	recover: reportCorruptStoredValue('Connection status'),
})
export const setRpcConnectionStatus = rpcConnectionStatusRepository.set
export const getRpcConnectionStatus = rpcConnectionStatusRepository.get

const ethereumSubscriptionsRepository = createStoredValueRepository<EthereumSubscriptionsAndFilters>({
	read: async () => (await browserStorageLocalGet('ethereumSubscriptionsAndFilters')).ethereumSubscriptionsAndFilters,
	write: async (ethereumSubscriptionsAndFilters) => { await browserStorageLocalSet({ ethereumSubscriptionsAndFilters }) },
	getDefault: () => [],
})
export const getEthereumSubscriptionsAndFilters = ethereumSubscriptionsRepository.get
export async function updateEthereumSubscriptionsAndFilters(updateFunc: (prevState: EthereumSubscriptionsAndFilters) => EthereumSubscriptionsAndFilters) {
	const { previous, current } = await ethereumSubscriptionsRepository.update(updateFunc)
	return { oldSubscriptions: previous, newSubscriptions: current }
}

const rpcListRepository = createStoredValueRepository<RpcEntries>({
	read: async () => (await browserStorageLocalGet('rpcEntries')).rpcEntries,
	write: async (rpcEntries) => { await browserStorageLocalSet({ rpcEntries }) },
	getDefault: () => DEFAULT_RPCS,
	recover: reportCorruptStoredValue('Rpc entries'),
})
export const setRpcList = rpcListRepository.set
export const getRpcList = rpcListRepository.get

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

export function repairLegacyAddressBookEntry(rawEntry: unknown): AddressBookEntry | undefined {
	const parsedEntry = AddressBookEntry.safeParse(rawEntry)
	if (parsedEntry.success) return parsedEntry.value
	const legacyErc20Entry = LegacyErc20TokenEntry.safeParse(rawEntry)
	if (!legacyErc20Entry.success || isValidErc20Decimals(legacyErc20Entry.value.decimals)) return undefined
	const { decimals: _decimals, symbol: _symbol, type: _type, ...contractFields } = legacyErc20Entry.value
	return { ...contractFields, type: 'contract' }
}

export function repairLegacyAddressBookEntries(rawEntries: unknown): AddressBookEntries | undefined {
	if (!Array.isArray(rawEntries)) return undefined
	const repairedEntries = rawEntries.map(repairLegacyAddressBookEntry)
	if (repairedEntries.some((entry) => entry === undefined)) return undefined
	return repairedEntries.filter((entry): entry is AddressBookEntry => entry !== undefined)
}

export async function getUserAddressBookEntries(): Promise<AddressBookEntries> {
	const { userAddressBookEntriesV3: rawEntries } = await browser.storage.local.get('userAddressBookEntriesV3')
	const parsedEntries = await browserStorageLocalSafeParseGet('userAddressBookEntriesV3')
	if (parsedEntries?.userAddressBookEntriesV3 !== undefined) return parsedEntries.userAddressBookEntriesV3
	if (rawEntries === undefined) return DEFAULT_ACTIVE_ADDRESSES
	const repairedEntries = repairLegacyAddressBookEntries(rawEntries)
	if (repairedEntries !== undefined) {
		await browserStorageLocalSet({ userAddressBookEntriesV3: repairedEntries })
		return repairedEntries
	}
	console.warn('userAddressBookEntriesV3 was corrupt:')
	console.warn(rawEntries)
	await browserStorageLocalSet({ userAddressBookEntriesV3: DEFAULT_ACTIVE_ADDRESSES })
	return DEFAULT_ACTIVE_ADDRESSES
}
export const getUserAddressBookEntriesForChainId = async (chainId: ChainIdWithUniversal) => (await getUserAddressBookEntries()).filter((entry) => entry.chainId === chainId || (entry.chainId === undefined && chainId === 1n) || entry.chainId === 'AllChains')
export const getUserAddressBookEntriesForChainIdMorePreciseFirst = async (chainId: ChainIdWithUniversal) => getAddressBookEntriesForChainIdMorePreciseFirst(await getUserAddressBookEntries(), chainId)

const userAddressBookEntriesSemaphore = new Semaphore(1)
export async function updateUserAddressBookEntries(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		return await browserStorageLocalSet({ userAddressBookEntriesV3: updateFunc(entries) })
	})
}

export async function updateUserAddressBookEntriesV2Old(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = (await browserStorageLocalGet('userAddressBookEntriesV2')).userAddressBookEntriesV2 ?? DEFAULT_ACTIVE_ADDRESSES
		return await browserStorageLocalSet({ userAddressBookEntriesV2: updateFunc(entries) })
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		const existingEntry = entries.find((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))
		if (existingEntry !== undefined) return
		return await browserStorageLocalSet({ userAddressBookEntriesV3: entries.concat(newEntry) })
	})
}

export async function setLatestUnexpectedError(latestUnexpectedError: UnexpectedErrorOccured | undefined) {
	if (latestUnexpectedError === undefined) return await browserStorageLocalRemove('latestUnexpectedError')
	return await browserStorageLocalSet({ latestUnexpectedError })
}

export async function getLatestUnexpectedError(): Promise<UnexpectedErrorOccured | undefined> {
	const { latestUnexpectedError: rawError } = await browser.storage.local.get('latestUnexpectedError')
	const parsedError = await browserStorageLocalSafeParseGet('latestUnexpectedError')
	if (parsedError?.latestUnexpectedError !== undefined) return parsedError.latestUnexpectedError
	if (rawError === undefined) return undefined
	console.warn('latestUnexpectedError was corrupt:')
	console.warn(rawError)
	await browserStorageLocalRemove('latestUnexpectedError')
	return undefined
}

const MAX_INTERCEPTOR_ERROR_DIAGNOSTICS = 50
const interceptorErrorDiagnosticsSemaphore = new Semaphore(1)

export async function getInterceptorErrorDiagnostics(): Promise<readonly InterceptorErrorDiagnostic[]> {
	try {
		return (await browserStorageLocalGet('interceptorErrorDiagnostics'))?.interceptorErrorDiagnostics ?? []
	} catch (error) {
		console.warn('interceptorErrorDiagnostics were corrupt:')
		console.warn(error)
		await browserStorageLocalRemove('interceptorErrorDiagnostics')
		return []
	}
}

export async function appendInterceptorErrorDiagnostic(diagnostic: InterceptorErrorDiagnostic) {
	await interceptorErrorDiagnosticsSemaphore.execute(async () => {
		const diagnostics = await getInterceptorErrorDiagnostics()
		await browserStorageLocalSet({
			interceptorErrorDiagnostics: [...diagnostics, diagnostic].slice(-MAX_INTERCEPTOR_ERROR_DIAGNOSTICS),
		})
	})
}

export async function clearInterceptorErrorDiagnostics() {
	await browserStorageLocalRemove('interceptorErrorDiagnostics')
}

export const getEnsNodeHashes = async () => (await browserStorageLocalGet('ensNameHashes'))?.ensNameHashes ?? []

const ensNodeHashesSemaphore = new Semaphore(1)
export async function addEnsNodeHash(name: string) {
	if (!isValidEnsName(name)) return
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
	const entry = { label, labelHash: BigInt(keccak256(stringToBytes(label))) }
	await ensLabelHashesSemaphore.execute(async () => {
		const oldEntries = await getEnsLabelHashes() || []
		if (oldEntries.find((old) => old.labelHash === entry.labelHash)) return
		return await browserStorageLocalSet({ ensLabelHashes: [...oldEntries, entry] })
	})
}

const transactionStateSemaphore = new Semaphore(1)
export const getInterceptorTransactionStack = async () => await getLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack) ?? { operations: [] }
export async function updateInterceptorTransactionStack(updateFunc: (prevStack: InterceptorTransactionStack) => InterceptorTransactionStack): Promise<InterceptorTransactionStack> {
	return await transactionStateSemaphore.execute(async () => {
		const prevStack = await getInterceptorTransactionStack()
		const interceptorTransactionStack = updateFunc(prevStack)
		assertUniqueInterceptorTransactionIds(interceptorTransactionStack)
		await setLargeStateValue('interceptorTransactionStack', InterceptorTransactionStack, interceptorTransactionStack)
		return interceptorTransactionStack
	})
}

export const getSafeTransactionStacks = async () => await getLargeStateValue('safeTransactionStacks', SafeTransactionStacks) ?? []

function assertUniqueInterceptorTransactionIds(interceptorTransactionStack: InterceptorTransactionStack) {
	const ids = interceptorTransactionStack.operations
		.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined)
		.filter((identifier): identifier is bigint => identifier !== undefined)
	if (new Set(ids).size !== ids.length) throw new Error('duplicated IDs')
}

type TransactionState = {
	readonly interceptorTransactionStack: InterceptorTransactionStack
	readonly safeTransactionStacks: SafeTransactionStacks
}

export async function updateTransactionState(updateFunc: (previousState: TransactionState) => TransactionState): Promise<TransactionState> {
	return await transactionStateSemaphore.execute(async () => {
		const previousState = {
			interceptorTransactionStack: await getInterceptorTransactionStack(),
			safeTransactionStacks: await getSafeTransactionStacks(),
		}
		const updatedState = updateFunc(previousState)
		assertUniqueInterceptorTransactionIds(updatedState.interceptorTransactionStack)
		await setLargeStateValues([
			prepareLargeStateWrite('interceptorTransactionStack', InterceptorTransactionStack, updatedState.interceptorTransactionStack),
			prepareLargeStateWrite('safeTransactionStacks', SafeTransactionStacks, updatedState.safeTransactionStacks),
		])
		return updatedState
	})
}

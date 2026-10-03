import * as funtypes from 'funtypes'
import { DirectSigningRecords, type DirectSigningRecord } from '../types/directSigning.js'
import { assertSigningWalletIdentity } from '../signing/publicAccountIdentity.js'
import { signingOperationError } from '../signing/signingOperationError.js'
import { getRpcEntryIdentityKey } from '../utils/rpcNetworkChange.js'
import { DEFAULT_TAB_CONNECTION, getChainName } from '../utils/constants.js'
import { Semaphore } from '../utils/semaphore.js'
import type { PendingChainChangeConfirmationPromise, PendingFetchSimulationStackRequestPromise, RpcConnectionStatus, StoredWatchAssetRequest, TabState } from '../types/user-interface-types.js'
import { type PartialIdsOfOpenedTabs, browserStorageLocalGet, browserStorageLocalGet2Result, browserStorageLocalRemove, browserStorageLocalSet, browserStorageLocalSet2, getTabStateFromStorage, parseTabStateItems, removeTabStateFromStorage, setTabStateToStorage } from '../utils/storageUtils.js'
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
import { SigningWallet, SigningWalletBindings, type SigningWalletBinding } from '../types/signingWallet.js'

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
async function readPendingTransactionsAndMessages() {
	const result = await browserStorageLocalGet2Result('pendingTransactionsAndMessages')
	if (!result.success) return result
	return { success: true as const, value: result.value.pendingTransactionsAndMessages ?? [] }
}

async function readPendingTransactionsAndMessagesWithRecovery(): Promise<readonly PendingTransactionOrSignableMessage[]> {
	const result = await readPendingTransactionsAndMessages()
	if (result.success) return result.value
	console.warn('Pending transactions were corrupt:')
	console.warn(result.error)
	await browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	return []
}

export async function getPendingTransactionsAndMessages(): Promise<readonly PendingTransactionOrSignableMessage[]> {
	const result = await readPendingTransactionsAndMessages()
	if (result.success) return result.value
	return await pendingTransactionsSemaphore.execute(readPendingTransactionsAndMessagesWithRecovery)
}

export const clearPendingTransactions = async () => await updatePendingTransactionOrMessages(async () => [])
async function updatePendingTransactionOrMessages(update: (pendingTransactionsOrMessages: readonly PendingTransactionOrSignableMessage[]) => Promise<readonly PendingTransactionOrSignableMessage[]>) {
	return await pendingTransactionsSemaphore.execute(async () => {
		const pendingTransactionsAndMessages = await update(await readPendingTransactionsAndMessagesWithRecovery())
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

/** Corrupt signing history must remain available for recovery, especially after ambiguous submission. */
export async function readDirectSigningRecords(): Promise<readonly DirectSigningRecord[]> {
	try {
		return (await browserStorageLocalGet('directSigningRequestsV1')).directSigningRequestsV1 ?? []
	} catch (error) {
		if (!(error instanceof funtypes.ValidationError)) throw error
		const { reportUnexpectedError } = await import('../utils/errors.js')
		await reportUnexpectedError(error, { source: 'direct_signing_storage', code: 'direct_signing_records_corrupt', displayMessage: 'Saved signing requests are corrupt. Existing data was preserved; signing is blocked until recovery.' })
		throw error
	}
}

const directSigningRecordsLock = new Semaphore(1)

export type DirectSigningRecordsTransaction = {
	read: typeof readDirectSigningRecords
	store: (record: DirectSigningRecord) => Promise<DirectSigningRecord>
}

/** Serialize the complete read/check/write lifecycle, including durable writes before network submission. */
export async function withDirectSigningRecords<T>(update: (transaction: DirectSigningRecordsTransaction) => Promise<T>): Promise<T> {
	return await directSigningRecordsLock.execute(async () => {
		let active = true
		const writes = new Semaphore(1)
		try {
			return await update({
				read: async () => {
					if (!active) throw new Error('Signing storage transaction has ended')
					return await readDirectSigningRecords()
				},
				store: async (record) => await writes.execute(async () => {
					if (!active) throw new Error('Signing storage transaction has ended')
					return await persistDirectSigningRecord(record)
				}),
			})
		} finally {
			active = false
			// Drain any started write before releasing the aggregate lock.
			await writes.execute(async () => undefined)
		}
	})
}

export async function storeDirectSigningRecord(record: DirectSigningRecord) {
	return await withDirectSigningRecords(async (transaction) => await transaction.store(record))
}

/** Retain ambiguous submissions and bounded recent history inside a storage transaction. */
async function persistDirectSigningRecord(record: DirectSigningRecord) {
	const records = await readDirectSigningRecords()
	const pending = await getPendingTransactionsAndMessages()
	const retained = records.filter((item) => item.id !== record.id && (item.phase === 'submitting' || pending.some((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, item.request))))
	const history = records.filter((item) => item.id !== record.id && !retained.includes(item) && ['submitted', 'confirmed', 'cancelled'].includes(item.phase)).slice(-4)
	const next = [...history, ...retained, record]
	const serialized = DirectSigningRecords.serialize(next)
	if (next.length > 16 || new TextEncoder().encode(JSON.stringify(serialized)).length > 4 * 1024 * 1024) throw signingOperationError('Too many saved signing requests. Finish or cancel pending signing requests before continuing.')
	await browserStorageLocalSet({ directSigningRequestsV1: next })
	return record
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

// Large-state getters share getLargeStateValue's failure contract: defaults apply only to successful absent/invalid reads. Rejections abort updates and reach the owning request/task boundary (e.g. catchAllErrorsAndCall in background-startup.ts), which reports the error; recovery is a later retry, never an empty-state write.
const simulationResultsSemaphore = new Semaphore(1)
export async function getPopupVisualisationState() {
	const emptyResults = createPassthroughCompleteVisualizedSimulation()
	return await getLargeStateValue('popupVisualisation', CompleteVisualizedSimulation) ?? emptyResults
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
	await rpcListRepository.update((rpcs) => {
		const selectedIndex = rpcs.findIndex((rpc) => getRpcEntryIdentityKey(rpc) === getRpcEntryIdentityKey(rpcNetwork))
		if (selectedIndex === -1) return rpcs
		return rpcs.map((rpc, index) => rpc.chainId === rpcNetwork.chainId ? modifyObject(rpc, { primary: index === selectedIndex }) : rpc)
	})
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

// Bindings are public identity only. A missing or corrupt binding never grants website access or establishes signing authority.
async function readSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await browserStorageLocalGet('signingWalletBindings')).signingWalletBindings ?? []
}

// A binding is global to an ordinary address, retained while any chain-scoped entry remains. A Safe entry in any scope excludes the address from ordinary-account signing.
function getOrdinarySigningAddresses(entries: AddressBookEntries) {
	const ordinaryAddresses = new Set(entries.filter((entry) => entry.type !== 'safe').map((entry) => entry.address))
	const safeAddresses = new Set(entries.filter((entry) => entry.type === 'safe').map((entry) => entry.address))
	return new Set([...ordinaryAddresses].filter((address) => !safeAddresses.has(address)))
}

function reconcileSigningWalletBindings(entries: AddressBookEntries, bindings: SigningWalletBindings) {
	const eligibleAddresses = getOrdinarySigningAddresses(entries)
	return bindings.filter((binding) => eligibleAddresses.has(binding.wallet.address))
}

// All combined writes enforce address classification here; imports validate strictly before reaching this boundary.
async function persistAddressBookAndSigningWalletBindings(entries: AddressBookEntries, bindings?: SigningWalletBindings, previousBindings?: SigningWalletBindings) {
	const reconciled = bindings === undefined ? undefined : reconcileSigningWalletBindings(entries, bindings)
	const bindingsChanged = reconciled !== undefined && (previousBindings === undefined || reconciled.length !== previousBindings.length || reconciled.some((binding, index) => binding !== previousBindings[index]))
	await browserStorageLocalSet({ userAddressBookEntriesV3: entries, ...(bindingsChanged ? { signingWalletBindings: reconciled } : {}) })
}

export async function getAddressBookAndSigningWalletBindings() {
	return await userAddressBookEntriesSemaphore.execute(async () => {
		const [entries, bindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		return { addressBookEntries: entries, signingWalletBindings: reconcileSigningWalletBindings(entries, bindings) }
	})
}

export async function getSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await getAddressBookAndSigningWalletBindings()).signingWalletBindings
}

/** Routing reads persisted public bindings without taking the address-book mutation lock; approval revalidates eligibility. */
export async function getStoredSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await readSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

export async function getSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await getSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

// The caller must present the revision it reviewed; onboarding uses undefined for an address with no binding. Address selection, mode, and website permissions are deliberately outside this mutation.
export async function saveAddressSigningWallet(address: bigint, wallet: SigningWallet | undefined, expectedRevision: string | undefined, newAddressName?: string) {
	const savedWallet = wallet === undefined ? undefined : Object.freeze({ ...wallet })
	if (savedWallet !== undefined) {
		if (!SigningWallet.safeSerialize(savedWallet).success) throw signingOperationError('Invalid signing wallet public account')
		if (savedWallet.address !== address) throw signingOperationError('Signing wallet does not match this address')
		assertSigningWalletIdentity(savedWallet)
	}
	return await userAddressBookEntriesSemaphore.execute(async () => {
		const [entries, storedBindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		const bindings = reconcileSigningWalletBindings(entries, storedBindings)
		const previous = bindings.find((binding) => binding.wallet.address === address)
		if (previous?.revision !== expectedRevision) throw signingOperationError('Signing wallet changed. Review the current wallet before saving again.')
		const existing = entries.find((entry) => entry.address === address)
		if (entries.some((entry) => entry.address === address && entry.type === 'safe')) throw signingOperationError('Assign a signing wallet to the Safe owner address, not the Safe.')
		if (existing === undefined && (newAddressName === undefined || newAddressName.trim().length === 0 || newAddressName.length > 100)) throw signingOperationError('Name the new address before saving its signing wallet')
		const binding = savedWallet === undefined ? undefined : { wallet: savedWallet, revision: crypto.randomUUID() }
		const nextBindings = [...bindings.filter((entry) => entry.wallet.address !== address), ...(binding === undefined ? [] : [binding])]
		if (!SigningWalletBindings.safeSerialize(nextBindings).success) throw signingOperationError('Too many or invalid signing wallet bindings')
		const nextEntries: AddressBookEntries = existing !== undefined ? entries : [...entries, { type: 'contact', address, name: newAddressName?.trim() ?? '', entrySource: 'User', useAsActiveAddress: true, chainId: 'AllChains' }]
		await persistAddressBookAndSigningWalletBindings(nextEntries, nextBindings, storedBindings)
		return binding
	})
}

/** Bind Safe owner/execution choices atomically with the saved wallets that make them usable. */
export async function saveSafeSigningAccounts(chainId: bigint, address: bigint, owner: bigint, executor: bigint | undefined, owners: readonly bigint[]) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		if (!entries.some((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId)) throw signingOperationError('Save this Safe in the address book before changing its signing accounts')
		const bindings = reconcileSigningWalletBindings(entries, await readSigningWalletBindings())
		if (!owners.includes(owner)) throw signingOperationError('The selected signing account is not a current Safe owner')
		if (!bindings.some((binding) => binding.wallet.address === owner)) throw signingOperationError('Set up the owner’s signing wallet first')
		// A gas payer need not be a Safe owner. A public binding is configuration, not proof of authority; the execution pipeline still checks the account and verifies its actual signature.
		if (executor !== undefined && !bindings.some((binding) => binding.wallet.address === executor)) throw signingOperationError('Set up the execution account’s signing wallet first')
		await browserStorageLocalSet({ userAddressBookEntriesV3: entries.map((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId ? { ...entry, safeSigningSignerAddress: owner, safeExecutionAddress: executor, safeSignerAddresses: owners } : entry) })
	})
}

/** Address-book-only writes. Callers removing addresses or introducing Safe classifications must use the signing-aware wrapper below. */
export async function updateUserAddressBookEntries(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		await browserStorageLocalSet({ userAddressBookEntriesV3: updateFunc(await getUserAddressBookEntries()) })
	})
}

/** Address edits atomically prune invalid signing bindings; unchanged eligibility skips signing-storage access. */
export async function updateAddressBookAndSigningWalletBindings(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = await getUserAddressBookEntries()
		const nextEntries = updateFunc(entries)
		const previousAddresses = getOrdinarySigningAddresses(entries)
		const nextAddresses = getOrdinarySigningAddresses(nextEntries)
		// Metadata-only edits cannot change binding eligibility, so they need no signing-storage access.
		if (previousAddresses.size === nextAddresses.size && [...previousAddresses].every((address) => nextAddresses.has(address))) {
			return await persistAddressBookAndSigningWalletBindings(nextEntries)
		}
		const bindings = await readSigningWalletBindings()
		// Check both snapshots so restoring an ordinary address never revives a previously orphaned binding.
		const nextBindings = bindings.filter((binding) => previousAddresses.has(binding.wallet.address) && nextAddresses.has(binding.wallet.address))
		return await persistAddressBookAndSigningWalletBindings(nextEntries, nextBindings, bindings)
	})
}

export async function replaceAddressBookAndSigningWalletBindings(entriesOrUpdate: AddressBookEntries | ((previous: AddressBookEntries) => AddressBookEntries), bindings: SigningWalletBindings) {
	if (!SigningWalletBindings.safeSerialize(bindings).success) throw new Error('Invalid imported signing wallet bindings')
	for (const binding of bindings) assertSigningWalletIdentity(binding.wallet)
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = typeof entriesOrUpdate === 'function' ? entriesOrUpdate(await getUserAddressBookEntries()) : entriesOrUpdate
		if (reconcileSigningWalletBindings(entries, bindings).length !== bindings.length) throw new Error('Imported signing wallets must belong to ordinary addresses in the imported address book')
		// Restoring the same backup is still an explicit wallet change and must invalidate approvals pinned to any earlier revision.
		await persistAddressBookAndSigningWalletBindings(entries, bindings.map((binding) => ({ wallet: binding.wallet, revision: crypto.randomUUID() })))
	})
}

export async function updateUserAddressBookEntriesV2Old(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await userAddressBookEntriesSemaphore.execute(async () => {
		const entries = (await browserStorageLocalGet('userAddressBookEntriesV2')).userAddressBookEntriesV2 ?? DEFAULT_ACTIVE_ADDRESSES
		return await browserStorageLocalSet({ userAddressBookEntriesV2: updateFunc(entries) })
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	await updateAddressBookAndSigningWalletBindings((entries) => {
		const existingEntry = entries.find((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))
		return existingEntry !== undefined ? entries : entries.concat(newEntry)
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

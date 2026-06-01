import { changeActiveAddressAndChain, changeActiveRpc, getUpdatedSimulationState, refreshConfirmTransactionSimulation } from './background.js'
import { getSettings, setUseTabsInsteadOfPopup, setPage, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, exportSettingsAndAddressBook, importSettingsAndAddressBook, getMakeCurrentAddressRich, getUseTabsInsteadOfPopup, getMetamaskCompatibilityMode, setMetamaskCompatibilityMode, getPage, setPreSimulationBlockTimeManipulation, getPreSimulationBlockTimeManipulation, getFixedAddressRichList, getWebsiteAccess, setMakeCurrentAddressRich, setFixedMakeMeRichList } from './settings.js'
import { getPendingTransactionsAndMessages, getCurrentTabId, getTabState, saveCurrentTabId, setRpcList, getRpcList, getPrimaryRpcForChain, getRpcConnectionStatus, updateUserAddressBookEntries, getPopupVisualisationState, setIdsOfOpenedTabs, getIdsOfOpenedTabs, updatePendingTransactionOrMessage, addEnsLabelHash, addEnsNodeHash, updateInterceptorTransactionStack, getLatestUnexpectedError, getInterceptorTransactionStack, getChainChangeConfirmationPromise, getFetchSimulationStackRequestPromise, getPendingAccessRequests } from './storageVariables.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { type ChangeActiveAddress, type ModifyMakeMeRich, type ChangePage, type RemoveTransaction, type RequestAccountsFromSigner, type TransactionConfirmation, type InterceptorAccess, type ChangeInterceptorAccess, type ChainChangeConfirmation, type EnableSimulationMode, type ChangeActiveChain, type AddOrEditAddressBookEntry, type GetAddressBookData, type RemoveAddressBookEntry, type InterceptorAccessRefresh, type InterceptorAccessChangeAddress, type Settings, type ChangeSettings, type ImportSettings, type SetRpcList, UpdateHomePage, type SimulateGovernanceContractExecution, type ChangeAddOrModifyAddressWindowState, type OpenWebPage, type DisableInterceptor, type SetEnsNameForHash, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions, SimulateExecutionReply, type BlockOrAllowExternalRequests, type RemoveWebsiteAccess, type AllowOrPreventAddressAccessForWebsite, type RemoveWebsiteAddressAccess, type ForceSetGasLimitForTransaction, type RetrieveWebsiteAccess, type ChangePreSimulationBlockTimeManipulation, type SetTransactionOrMessageBlockTimeManipulator, type FetchSimulationStackRequestConfirmation, type ImportSimulationStack, type PopupReadyAndListeningPage } from '../types/interceptor-messages.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransactionOrMessage, updateConfirmTransactionView, setGasLimitForTransaction, toPopupPendingTransactionOrSignableMessage } from './windows/confirmTransaction.js'
import { askForSignerAccountsFromSignerIfNotAvailable, requestAddressChange, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { hasAccess, sendMessageToApprovedWebsitePorts, setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from './medataSearch.js'
import { getActiveAddressEntry, getActiveAddresses, identifyAddress } from './metadataUtils.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { CompleteVisualizedSimulation, InterceptorSimulationExport, type InterceptorStackOperation, InterceptorTransactionStack, type ModifyAddressWindowState } from '../types/visualizer-types.js'
import { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { isJSON } from '../utils/json.js'
import type { IncompleteAddressBookEntry } from '../types/addressBookTypes.js'
import { EthereumAddress, serialize } from '../types/wire-types.js'
import { fetchAbiFromBlockExplorer, isValidAbi } from '../simulation/services/EtherScanAbiFetcher.js'
import { checksummedAddress, generate256BitRandomBigInt, stringToAddress } from '../utils/bigint.js'
import { isAddress } from '../utils/viem.js'
import { getIssueWithAddressString } from '../utils/addressValidation.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { checkAndThrowRuntimeLastError, silenceChromeUnCaughtPromise, updateTabIfExists } from '../utils/requests.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { buildWebsiteAccessPopupData, getAddressMetadataForAccess, sendWebsiteAccessChangedFromWebsiteAccess } from './websiteAccessPopup.js'
import { getCurrentSimulationInput, getMetadataForSimulation, simulateGnosisSafeMetaTransaction, simulateGovernanceContractExecution, updateSimulationMetadata, visualizeSimulatorState } from './simulationUpdating.js'
import { handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import type { ImportSimulationStackReply, RequestAbiAndNameFromBlockExplorer, RequestIdentifyAddress, UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { getWebsiteCreatedEthereumUnsignedTransactions } from '../simulation/services/SimulationModeEthereumClientService.js'
import { updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from './popupVisualisationUpdater.js'
import { resolveFetchSimulationStackRequest } from './windows/fetchSimulationStack.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from './windows/fetchSimulationStack.js'
import { estimateSerializedStateBytes, formatEstimatedBytes } from '../utils/largeStateStore.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../utils/popupPerformance.js'
import { doWebsiteOriginsShareHostname } from '../utils/websiteOrigins.js'

type TimestampedPopupVisualisation = {
	data: {
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationConductedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationState.simulationConductedTimestamp

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown error'

const importSimulationStackSuccess = (): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: true })
const importSimulationStackFailure = (message: string): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: false, message })

async function refreshSignerAccountsForTabIfNeeded(websiteTabConnections: WebsiteTabConnections, tabId: number | undefined, tabState: TabState, shouldRefreshSignerAccounts: boolean) {
	if (!shouldRefreshSignerAccounts || tabId === undefined) return tabState
	if (tabState.signerAccounts.length !== 0) return tabState
	if (tabState.signerName === 'NoSigner' || tabState.signerName === 'NoSignerDetected') return tabState

	const tabConnections = websiteTabConnections.get(tabId)
	if (tabConnections === undefined) return tabState
	const approvedConnection = Object.values(tabConnections.connections).find((connection) => connection.approved)
	if (approvedConnection === undefined) return tabState

	await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, approvedConnection.socket, false)
	return await getTabState(tabId)
}

export async function confirmDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, confirmation)
}

export async function confirmRequestAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, confirmation.data)
}

export async function getLastKnownCurrentTabId() {
	const tabIdPromise = getCurrentTabId()
	silenceChromeUnCaughtPromise(tabIdPromise)
	const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true })
	const tabId = await tabIdPromise
	// skip restricted or insufficient permission tabs
	if (tabs[0]?.id === undefined || tabs[0]?.url === undefined) return tabId
	if (tabId !== tabs[0].id) saveCurrentTabId(tabs[0].id)
	return tabs[0].id
}

export async function popupReadyAndListening(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, page: PopupReadyAndListeningPage) {
	switch (page) {
		case 'changeChain': {
			const promise = await getChainChangeConfirmationPromise()
			if (promise === undefined) return undefined
			await updateChainChangeViewWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
				},
			}
		}
		case 'confirmTransaction': {
			const pendingTransactions = await getPendingTransactionsAndMessages()
			const firstPendingTransaction = pendingTransactions[0]
			if (firstPendingTransaction === undefined) return undefined
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingTransaction.popupOrTabId,
				},
			}
		}
		case 'interceptorAccess': {
			const pendingAccessRequests = await getPendingAccessRequests()
			const firstPendingAccessRequest = pendingAccessRequests[0]
			if (firstPendingAccessRequest === undefined) return undefined
			await updateInterceptorAccessViewWithPendingRequests()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingAccessRequest.popupOrTabId,
				},
			}
		}
		case 'fetchSimulationStack': {
			const promise = await getFetchSimulationStackRequestPromise()
			if (promise === undefined) return undefined
			await updateFetchSimulationStackRequestWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
				},
			}
		}
		default:
			assertNever(page)
	}
}

async function getSignerAccount() {
	const tabId = await getLastKnownCurrentTabId()
	const signerAccounts = tabId === undefined ? undefined : (await getTabState(tabId)).signerAccounts
	return signerAccounts !== undefined && signerAccounts.length > 0 ? signerAccounts[0] : undefined
}

export async function changeActiveAddress(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, addressChange: ChangeActiveAddress) {
	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if (addressChange.data.activeAddress === 'signer') {
		const signerAccount = await getSignerAccount()
		await setUseSignersAddressAsActiveAddress(addressChange.data.activeAddress === 'signer', signerAccount)
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })

			await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: addressChange.data.simulationMode,
				activeAddress: signerAccount,
			})
		} else {
			await setUseSignersAddressAsActiveAddress(false)
			await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: addressChange.data.simulationMode,
				activeAddress: addressChange.data.activeAddress,
			})
		}
}

export async function modifyMakeMeRich(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, makeMeRichChange: ModifyMakeMeRich) {
	if (makeMeRichChange.data.address === 'CurrentAddress') {
		await setMakeCurrentAddressRich(makeMeRichChange.data.add)
	} else {
		const currentList = await getFixedAddressRichList()
		if (makeMeRichChange.data.add) {
			await setFixedMakeMeRichList([...currentList, {
				address: makeMeRichChange.data.address,
				makingRich: true,
				type: 'UserAdded'
			}])
		} else {
			await setFixedMakeMeRichList(currentList.filter((element) => element.address !== makeMeRichChange.data.address))
		}
	}
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, true)
}

export async function removeAddressBookEntry(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => previousContacts.filter((contact) =>
		!(contact.address === removeAddressBookEntry.data.address
		&& (contact.chainId === removeAddressBookEntry.data.chainId || (contact.chainId === undefined && removeAddressBookEntry.data.chainId === 1n))))
	)
	if (removeAddressBookEntry.data.addressBookCategory === 'My Active Addresses') await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function addOrModifyAddressBookEntry(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => {
		if (previousContacts.find((previous) => previous.address === entry.data.address && (previous.chainId || 1n) === (entry.data.chainId || 1n)) ) {
			return previousContacts.map((previous) => previous.address === entry.data.address && (previous.chainId || 1n) === (entry.data.chainId || 1n) ? entry.data : previous)
		}
		return previousContacts.concat([entry.data])
	})
	if (entry.data.useAsActiveAddress) await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function changeInterceptorAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess((previousAccess) => {
		const withEntriesRemoved = previousAccess.filter((acc) => accessChange.data.find((change) => change.newEntry.website.websiteOrigin === acc.website.websiteOrigin)?.removed !== true)
		return withEntriesRemoved.map((entry) => {
			const changeForEntry = accessChange.data.find((change) => change.newEntry.website.websiteOrigin === entry.website.websiteOrigin)
			if (changeForEntry === undefined) return entry
			return changeForEntry.newEntry
		})
	})

	const interceptorDisablesChanged = accessChange.data.filter((x) => x.newEntry.interceptorDisabled !== x.oldEntry.interceptorDisabled).map((x) => x)
	await Promise.all(interceptorDisablesChanged.map(async (disable) => {
		if (disable.newEntry.interceptorDisabled === undefined) return
		return await disableInterceptorForPage(websiteTabConnections, disable.newEntry.website, disable.newEntry.interceptorDisabled)
	}))

	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export const changePage = async (page: ChangePage) => await setPage(page.data)

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

const normalizeConsecutiveTimeManipulations = (operations: readonly InterceptorStackOperation[]) => {
	return operations.filter((operation, operationIndex) => !(operationIndex > 0 && operation.type === 'TimeManipulation' && operations[operationIndex - 1]?.type === 'TimeManipulation'))
}

export async function removeTransactionOrSignedMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, params: RemoveTransaction) {
	await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		switch (params.data.type) {
			case 'Transaction': {
				const transactionIdentifier = params.data.transactionIdentifier
				const transactionToBeRemoved = prevStack.operations.find((transaction): transaction is Extract<InterceptorStackOperation, { type: 'Transaction' }> => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
				if (transactionToBeRemoved === undefined) return prevStack
				const removedTransaction = transactionToBeRemoved.preSimulationTransaction
				const shouldShiftNonceAfterRemoval = (transaction: typeof removedTransaction) => {
					return transactionWasFound
						&& transaction.originalRequestParameters.method === 'eth_sendTransaction'
						&& transaction.signedTransaction.from === removedTransaction.signedTransaction.from
						&& transaction.signedTransaction.nonce > removedTransaction.signedTransaction.nonce
				}

				const newOperations: InterceptorStackOperation[] = []
				let transactionWasFound = false
				for (const operation of prevStack.operations) {
					if (operation.type === 'Transaction' && transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier) {
						transactionWasFound = true
						continue
					}
					if (operation.type === 'Transaction') {
						const transaction = operation.preSimulationTransaction
						const shouldUpdateNonce = shouldShiftNonceAfterRemoval(transaction)
						const newTransaction = shouldUpdateNonce ? modifyObject(transaction.signedTransaction, { nonce: transaction.signedTransaction.nonce - 1n }) : transaction.signedTransaction
						newOperations.push({
							type: operation.type,
							preSimulationTransaction: {
								signedTransaction: newTransaction,
								website: transaction.website,
								created: transaction.created,
								originalRequestParameters: transaction.originalRequestParameters,
								transactionIdentifier: transaction.transactionIdentifier,
							}
						})
						continue
					}
					newOperations.push(operation)
				}
				return { operations: normalizeConsecutiveTimeManipulations(newOperations) }
			}
			case 'Message': {
				const messageIdentifier = params.data.messageIdentifier
				return {
					operations: normalizeConsecutiveTimeManipulations(prevStack.operations)
						.filter((operation) => !(operation.type === 'Message' && messageIdentifier === operation.signedMessageTransaction.messageIdentifier))
				}
			}
			default: assertNever(params.data)
		}
	})

	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
}

export async function refreshPopupConfirmTransactionMetadata(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined) {
	const currentBlockNumberPromise = ethereum.getBlockNumber(requestAbortController)
	silenceChromeUnCaughtPromise(currentBlockNumberPromise)
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const promises = await getPendingTransactionsAndMessages()
	const visualizedSimulatorStatePromise = silenceChromeUnCaughtPromise(updatePopupVisualisationIfNeeded(ethereum, tokenPriceService))
	const first = promises[0]
	if (first === undefined) return
	switch (first.type) {
		case 'SignableMessage': {
			const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereum, requestAbortController, first.signedMessageTransaction, ethereum.getRpcEntry())
			silenceChromeUnCaughtPromise(visualizedPersonalSignRequestPromise)
			const message: UpdateConfirmTransactionDialog = {
				method: 'popup_update_confirm_transaction_dialog',
				data: {
					visualizedSimulatorState: await visualizedSimulatorStatePromise,
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
				data: {
					pendingTransactionAndSignableMessages: [{
						...first,
						visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise,
						transactionOrMessageCreationStatus: 'Simulated' as const
					}, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			await Promise.all([
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
			])
			return
		}
		case 'Transaction': {
			if (first.transactionOrMessageCreationStatus !== 'Simulated' || first.popupVisualisation.statusCode === 'failed') return
			try {
				const visualizedSimulationState = await visualizeSimulatorState(first.popupVisualisation.data.simulationState, ethereum, tokenPriceService, requestAbortController)
				const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
					data: {
						pendingTransactionAndSignableMessages: [
							modifyObject(first,
								{
									popupVisualisation: {
										statusCode: 'success',
										data: modifyObject(first.popupVisualisation.data, { ...visualizedSimulationState })
									}
								})
							, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				const message: UpdateConfirmTransactionDialog = {
					method: 'popup_update_confirm_transaction_dialog' as const,
					data: {
						visualizedSimulatorState: await visualizedSimulatorStatePromise,
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				await Promise.all([
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
				])
				return
			} catch(error: unknown) {
				if (error instanceof Error && isNewBlockAbort(error)) return
				if (error instanceof Error && isFailedToFetchError(error)) return
				throw error
			}
		}
		default: assertNever(first)
	}
}

export async function refreshPopupConfirmTransactionSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const [firstTxn] = await getPendingTransactionsAndMessages()
	if (firstTxn === undefined || firstTxn.type !== 'Transaction' || (firstTxn.transactionOrMessageCreationStatus !== 'Simulated' && firstTxn.transactionOrMessageCreationStatus !== 'FailedToSimulate')) return
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction' ? await formEthSendTransaction(ethereum, undefined, firstTxn.activeAddress, firstTxn.transactionToSimulate.website, firstTxn.originalRequestParameters, firstTxn.created, firstTxn.transactionIdentifier, firstTxn.simulationMode) : await formSendRawTransaction(ethereum, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created, firstTxn.transactionIdentifier)
	const refreshMessage = await refreshConfirmTransactionSimulation(ethereum, tokenPriceService, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.uniqueRequestIdentifier, transactionToSimulate)
	if (refreshMessage === undefined) return
	await updatePendingTransactionOrMessage(firstTxn.uniqueRequestIdentifier, async (transactionOrMessage) => {
		switch (transactionOrMessage.type) {
			case 'SignableMessage': throw new Error('Tried to refresh simulation of a message')
			case 'Transaction': {
				if (transactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated' && transactionOrMessage.transactionOrMessageCreationStatus !== 'FailedToSimulate') return transactionOrMessage
				const currentTimestamp = getSimulationConductedTimestamp(transactionOrMessage.popupVisualisation)
				const nextTimestamp = getSimulationConductedTimestamp(refreshMessage)
				if (currentTimestamp !== undefined && nextTimestamp !== undefined && nextTimestamp.getTime() < currentTimestamp.getTime()) return transactionOrMessage
				if (transactionToSimulate.success) {
					return {
						...transactionOrMessage,
						transactionToSimulate,
						popupVisualisation: refreshMessage,
						transactionOrMessageCreationStatus: 'Simulated' as const,
					}
				}
				return {
					...transactionOrMessage,
					transactionToSimulate,
					popupVisualisation: refreshMessage,
					transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
				}
			}
			default: assertNever(transactionOrMessage)
		}
	})
	await updateConfirmTransactionView(ethereum, tokenPriceService, true)
}

export async function popupChangeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, params: ChangeActiveChain, settings: Settings) {
	return await changeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, params.data, settings.simulationMode)
}

export async function changeChainDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, chainChange)
}

export async function enableSimulationMode(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, params: EnableSimulationMode) {
	const settings = await getSettings()
	// if we are on unsupported chain, force change to a supported one
	if (settings.useSignersAddressAsActiveAddress || params.data === false) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
		const tabId = await getLastKnownCurrentTabId()
		const chainToSwitch = tabId === undefined ? undefined : (await getTabState(tabId)).signerChain
		const networkToSwitch = chainToSwitch === undefined ? (await getRpcList())[0] : await getPrimaryRpcForChain(chainToSwitch)
			await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: params.data,
				activeAddress: await getSignerAccount(),
				...chainToSwitch === undefined ? {} : { rpcNetwork: networkToSwitch },
			})
		} else {
			const selectedNetworkToSwitch = settings.activeRpcNetwork.httpsRpc !== undefined ? settings.activeRpcNetwork : (await getRpcList())[0]
			await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: params.data,
				...settings.activeRpcNetwork === selectedNetworkToSwitch ? {} : { rpcNetwork: selectedNetworkToSwitch }
			})
		}
}

export async function getAddressBookData(parsed: GetAddressBookData) {
	const data = await getMetadataForAddressBookData(parsed.data)
	await sendPopupMessageToOpenWindows({
		method: 'popup_getAddressBookDataReply',
		data: {
			data: parsed.data,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

export const openNewTab = async (tabName: 'settingsView' | 'addressBook' | 'websiteAccess') => {
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: getHtmlFile(tabName) })
		if (tab.id !== undefined) await setIdsOfOpenedTabs({ [tabName]: tab.id })
	}

	const tabId = (await getIdsOfOpenedTabs())[tabName]
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	const tab = await updateTabIfExists(addressBookTab.id, { active: true, highlighted: true })
	if (tab === undefined) await openInNewTab()
}

export async function requestNewHomeData(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	shouldRefreshSignerAccounts: boolean,
	requestAbortController: AbortController | undefined,
) {
	const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, { requestAbortController, richDataSource: 'cached', shouldRefreshSignerAccounts })
	await sendPopupMessageToOpenWindows(serialize(UpdateHomePage, updatedPage))
}

export async function refreshHomeData(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, shouldRefreshSignerAccounts: boolean, refreshSimulation = true, requestAbortController: AbortController | undefined = undefined) {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshStart)
	try {
		const currentSettings = await getSettings()
		if (currentSettings.simulationMode) await updateSimulationMetadata(ethereum, requestAbortController)
		if (refreshSimulation) await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
		const settings = await getSettings()
		if (settings.activeRpcNetwork.httpsRpc !== undefined) await makeSureInterceptorIsNotSleeping(ethereum)
		const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, { requestAbortController, richDataSource: 'fresh', shouldRefreshSignerAccounts })
		await sendPopupMessageToOpenWindows(serialize(UpdateHomePage, updatedPage))
	} finally {
		markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshEnd)
	}
}

export async function settingsOpened() {
	const useTabsInsteadOfPopupPromise = silenceChromeUnCaughtPromise(getUseTabsInsteadOfPopup())
	const metamaskCompatibilityModePromise = silenceChromeUnCaughtPromise(getMetamaskCompatibilityMode())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())

	await sendPopupMessageToOpenWindows({
		method: 'popup_requestSettingsReply' as const,
		data: {
			useTabsInsteadOfPopup: await useTabsInsteadOfPopupPromise,
			metamaskCompatibilityMode: await metamaskCompatibilityModePromise,
			rpcEntries: await rpcEntriesPromise,
			activeRpcNetwork: (await settingsPromise).activeRpcNetwork
		}
	})
}

export async function interceptorAccessChangeAddressOrRefresh(websiteTabConnections: WebsiteTabConnections, params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(websiteTabConnections, params)
}

export async function changeSettings(ethereum: EthereumClientService, _tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, parsedRequest: ChangeSettings, requestAbortController: AbortController | undefined) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	return await requestNewHomeData(ethereum, new Map(), false, requestAbortController)
}

export async function importSettings(settingsData: ImportSettings) {
	if (!isJSON(settingsData.data.fileContents)) {
		await sendPopupMessageToOpenWindows({
			method: 'popup_initiate_export_settings_reply',
			data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' }
		})
		return
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		await sendPopupMessageToOpenWindows({
			method: 'popup_initiate_export_settings_reply',
			data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' }
		})
		return
	}
	await importSettingsAndAddressBook(parsed.value)
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings_reply',
		data: { success: true }
	})
}

export async function exportSettings() {
	const exportedSettings = await exportSettingsAndAddressBook()
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings',
		data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings), undefined, 4) }
	})
}

export async function setNewRpcList(resetSimulationServices: ResetSimulationServices, request: SetRpcList, settings: Settings) {
	await setRpcList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	const primary = await getPrimaryRpcForChain(settings.activeRpcNetwork.chainId)
	if (primary !== undefined) {
		// reset to primary on update
		resetSimulationServices(primary)
	}
}

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, request: SimulateGovernanceContractExecution) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const transaction = pendingTransactions.find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === request.data.transactionIdentifier)
	if (transaction === undefined || transaction.type !== 'Transaction') throw new Error(`Could not find transactionIdentifier: ${ request.data.transactionIdentifier }`)
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(transaction, ethereum, tokenPriceService)
	await sendPopupMessageToOpenWindows(serialize(SimulateExecutionReply, {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...governanceContractExecutionVisualisation, transactionOrMessageIdentifier: request.data.transactionIdentifier }
	}))
}

export async function simulateGnosisSafeTransactionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) {
	const gnosisTransactionExecutionVisualisation = await simulateGnosisSafeMetaTransaction(gnosisSafeMessage, await getCurrentSimulationInput(), ethereum, tokenPriceService)
	await sendPopupMessageToOpenWindows(serialize(SimulateExecutionReply, {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...gnosisTransactionExecutionVisualisation, transactionOrMessageIdentifier: gnosisSafeMessage.messageIdentifier }
	}))
}

const getErrorIfAnyWithIncompleteAddressBookEntry = async (ethereum: EthereumClientService, incompleteAddressBookEntry: IncompleteAddressBookEntry) => {
	// check for duplicates
	const duplicateEntry = await findEntryWithSymbolOrName(incompleteAddressBookEntry.symbol, incompleteAddressBookEntry.name, incompleteAddressBookEntry.chainId)
	if (duplicateEntry !== undefined && duplicateEntry.address !== stringToAddress(incompleteAddressBookEntry.address)) {
		return `There already exists ${ duplicateEntry.type } with ${ 'symbol' in duplicateEntry ? `the symbol "${ duplicateEntry.symbol }" and` : '' } the name "${ duplicateEntry.name }".`
	}

	// check that address is valid
	if (incompleteAddressBookEntry.address !== undefined) {
		const trimmed = incompleteAddressBookEntry.address.trim()
		if (isAddress(trimmed)) {
			const address = EthereumAddress.parse(trimmed)
			if (incompleteAddressBookEntry.addingAddress) {
				const identifiedAddress = await identifyAddress(ethereum, undefined, address)
				if (identifiedAddress.entrySource !== 'OnChain' && identifiedAddress.entrySource !== 'FilledIn') {
					return 'The address already exists. Edit the existing record instead trying to add it again.'
				}
			}
		}
		const issue = getIssueWithAddressString(trimmed)
		if (issue !== undefined) return issue
	}

	// check that ABI is valid
	const trimmedAbi = incompleteAddressBookEntry.abi === undefined ? undefined : incompleteAddressBookEntry.abi.trim()
	if (trimmedAbi !== undefined && trimmedAbi.length !== 0 && (!isJSON(trimmedAbi) || !isValidAbi(trimmedAbi))) {
		return 'The Abi provided is not a JSON ABI. Please provide a valid JSON ABI.'
	}
	return undefined
}

export async function changeAddOrModifyAddressWindowState(ethereum: EthereumClientService, parsedRequest: ChangeAddOrModifyAddressWindowState) {
	const updatePage = async (newState: ModifyAddressWindowState) => {
		const currentPage = await getPage()
		if ((currentPage.page === 'AddNewAddress' || currentPage.page === 'ModifyAddress') && currentPage.state.windowStateId === parsedRequest.data.windowStateId) {
			await setPage({ page: currentPage.page, state: newState })
		}
	}
	await updatePage(parsedRequest.data.newState)
	const message = await getErrorIfAnyWithIncompleteAddressBookEntry(ethereum, parsedRequest.data.newState.incompleteAddressBookEntry)

	const errorState = message === undefined ? undefined : { blockEditing: true, message }
	if (errorState?.message !== parsedRequest.data.newState.errorState?.message) await updatePage({ ...parsedRequest.data.newState, errorState })
	await sendPopupMessageToOpenWindows({
		method: 'popup_addOrModifyAddressWindowStateInformation',
		data: { windowStateId: parsedRequest.data.windowStateId, errorState: errorState }
	})
}

export async function requestAbiAndNameFromBlockExplorer(parsedRequest: RequestAbiAndNameFromBlockExplorer) {
	const etherscanReply = await fetchAbiFromBlockExplorer(parsedRequest.data.address, parsedRequest.data.chainId)
	if (etherscanReply.success) {
		return {
			method: 'popup_requestAbiAndNameFromBlockExplorer' as const,
			data: {
				success: true,
				abi: etherscanReply.abi,
				contractName: etherscanReply.contractName,
			}
		} as const
	}
	return {
		method: 'popup_requestAbiAndNameFromBlockExplorer' as const,
		data: {
			success: false,
			error: etherscanReply.error
		}
	} as const
}

export async function openWebPage(parsedRequest: OpenWebPage) {
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === parsedRequest.data.websiteSocket.tabId)
	if (addressBookTab === undefined) {
		await browser.tabs.create({ url: parsedRequest.data.url, active: true })
		return
	}
	try {
		await browser.tabs.update(parsedRequest.data.websiteSocket.tabId, { url: parsedRequest.data.url, active: true })
		checkAndThrowRuntimeLastError()
		return
	} catch (error) {
		console.warn('Failed to update tab with new webpage')
		console.warn({ error })
	}
	await browser.tabs.create({ url: parsedRequest.data.url, active: true })
}

// reload all connected tabs of the same origin and the current webpage
async function reloadConnectedTabs(websiteTabConnections: WebsiteTabConnections) {
	const tabIdsToRefesh = Array.from(websiteTabConnections.entries()).map(([tabId]) => tabId)
	const currentTabId = await getLastKnownCurrentTabId()
	const withCurrentTabid = currentTabId === undefined ? tabIdsToRefesh : [...tabIdsToRefesh, currentTabId]
	for (const tabId of new Set(withCurrentTabid)) {
		try {
			await browser.tabs.reload(tabId)
			checkAndThrowRuntimeLastError()
		} catch (e) {
			console.warn('Failed to reload tab')
			console.warn(e)
		}
	}
}

async function disableInterceptorForPage(websiteTabConnections: WebsiteTabConnections, website: Website, interceptorDisabled: boolean) {
	await setInterceptorDisabledForWebsite(website, interceptorDisabled)
	if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3()
	else await updateContentScriptInjectionStrategyManifestV2()

	await reloadConnectedTabs(websiteTabConnections)
}

export async function disableInterceptor(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await disableInterceptorForPage(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function setEnsNameForHash(parsedRequest: SetEnsNameForHash) {
	if (parsedRequest.data.type === 'labelHash') {
		await addEnsLabelHash(parsedRequest.data.name)
	} else {
		await addEnsNodeHash(parsedRequest.data.name)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	await sendPopupMessageToOpenWindows({
		method: 'popup_retrieveWebsiteAccessReply',
		data: await buildWebsiteAccessPopupData(parsedRequest.data.query),
	})
}

async function blockOrAllowWebsiteExternalRequests(websiteTabConnections: WebsiteTabConnections, website: Website, shouldBlock: boolean) {
	await updateWebsiteAccess((previousAccessList) => {
		return previousAccessList.map((access) => {
			if (!doWebsiteOriginsShareHostname(access.website.websiteOrigin, website.websiteOrigin)) return access
			return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
		})
	})

	await reloadConnectedTabs(websiteTabConnections)
}

export async function blockOrAllowExternalRequests(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await blockOrAllowWebsiteExternalRequests(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.shouldBlock)
	const settings = await getSettings()
	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, settings)
	await sendWebsiteAccessChangedFromWebsiteAccess(settings.websiteAccess)
}

async function removeAddressAccessByAddress(websiteOrigin: string, address: EthereumAddress) {
	await updateWebsiteAccess((previousAccessList) => {
		return previousAccessList.map(access => {
			if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
			const strippedAddressAccess = access.addressAccess.filter(addressAccess => addressAccess.address !== address)
			return modifyObject(access, { addressAccess: strippedAddressAccess })
		})
	})
}

export async function removeWebsiteAddressAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await removeAddressAccessByAddress(parsedRequest.data.websiteOrigin, parsedRequest.data.address)
	await reloadConnectedTabs(websiteTabConnections)
	const settings = await getSettings()
	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, settings)
	await sendWebsiteAccessChangedFromWebsiteAccess(settings.websiteAccess)
}

async function setAdressAccessForWebsite(websiteOrigin: string, address: EthereumAddress, allowAccess: boolean) {
	await updateWebsiteAccess((previousAccessList) => {
		return previousAccessList.map((access) => {
			if (access.website.websiteOrigin !== websiteOrigin || access.addressAccess === undefined) return access
			const addressAccessList = access.addressAccess.map(addressAccess => (addressAccess.address !== address) ? addressAccess : modifyObject(addressAccess, { access: allowAccess }))
			return modifyObject(access, { addressAccess: addressAccessList })
		})
	})
}

export async function allowOrPreventAddressAccessForWebsite(websiteTabConnections: WebsiteTabConnections, parsedRequest: AllowOrPreventAddressAccessForWebsite) {
	const { website, address, allowAccess } = parsedRequest.data
	await setAdressAccessForWebsite(website.websiteOrigin, address, allowAccess)
	await reloadConnectedTabs(websiteTabConnections)
	const settings = await getSettings()
	await sendWebsiteAccessChangedFromWebsiteAccess(settings.websiteAccess)
}

export async function removeWebsiteAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	await updateWebsiteAccess((previousAccess) => previousAccess.filter((access) => !doWebsiteOriginsShareHostname(access.website.websiteOrigin, parsedRequest.data.websiteOrigin)))
	const settings = await getSettings()
	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, settings)
	await sendWebsiteAccessChangedFromWebsiteAccess(settings.websiteAccess)
}
export async function forceSetGasLimitForTransaction(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ForceSetGasLimitForTransaction) {
	await setGasLimitForTransaction(parsedRequest.data.transactionIdentifier, parsedRequest.data.gasLimit)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
	await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
}

export async function changePreSimulationBlockTimeManipulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ChangePreSimulationBlockTimeManipulation) {
	await setPreSimulationBlockTimeManipulation(parsedRequest.data.blockTimeManipulation)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, true)
}

export async function setTransactionOrMessageBlockTimeManipulator(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: SetTransactionOrMessageBlockTimeManipulator) {
	const newStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		const normalizedPrevStack = { operations: normalizeConsecutiveTimeManipulations(prevStack.operations) }
		const identifier = parsedRequest.data.transactionOrMessageIdentifier
		const appendAfterIndex = normalizedPrevStack.operations.findIndex((operation) => {
			switch(operation.type) {
				case 'Transaction': return identifier.type === operation.type && identifier.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
				case 'Message': return identifier.type === operation.type && identifier.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
				case 'TimeManipulation': return false
				default: return assertNever(operation)
			}
		})
		if (appendAfterIndex < 0) return normalizedPrevStack
		const indexOfMaybeManipulator = appendAfterIndex + 1
		const maybeExistingManipulator = normalizedPrevStack.operations[indexOfMaybeManipulator]
		if (maybeExistingManipulator?.type === 'TimeManipulation') {
			// no delay, so we can remove the manipulator
			if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator + 1)]) }
			const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
			// replace manipulator
			return { operations: normalizeConsecutiveTimeManipulations(normalizedPrevStack.operations.map((operation, index) => index === indexOfMaybeManipulator ? newManipulator : operation)) }
		}
		// insert new manipulator
		if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return normalizedPrevStack
		const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
		return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), newManipulator, ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator)]) }
	})
	const secondToLastOperation = newStack.operations[newStack.operations.length - 2]
	if (secondToLastOperation === undefined || secondToLastOperation.type === 'TimeManipulation') {
		await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, true)
		return
	}
	const appendIdentifier = parsedRequest.data.transactionOrMessageIdentifier.type === 'Transaction' ? parsedRequest.data.transactionOrMessageIdentifier.transactionIdentifier : parsedRequest.data.transactionOrMessageIdentifier.messageIdentifier
	const operationIdentifier = secondToLastOperation.type === 'Transaction' ? secondToLastOperation.preSimulationTransaction.transactionIdentifier : secondToLastOperation.signedMessageTransaction.messageIdentifier
	const appendedToEnd = appendIdentifier === operationIdentifier
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, !appendedToEnd, true)
}

export async function requestMakeMeRichList(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined) {
	const makeMeRichPromise = silenceChromeUnCaughtPromise(getMakeCurrentAddressRich())
	const fixedAddressRichList = await getFixedAddressRichList()
	const fixedRichListPromises = Array.from(fixedAddressRichList.values()).map(async(element) => {
		try {
			return { ...element, addressBookEntry: await identifyAddress(ethereumClientService, requestAbortController, element.address) }
		} catch (error) {
			const address = checksummedAddress(element.address)
			const errorMessage = error instanceof Error ? error.message : 'Unknown error'
			await handleUnexpectedError(new Error(`Failed to identify rich list address ${ address }: ${ errorMessage }`))
			return {
				...element,
				addressBookEntry: {
					type: 'contact' as const,
					name: address,
					address: element.address,
					entrySource: 'FilledIn' as const,
				}
			}
		}
	})
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedRichListPromises),
		makeCurrentAddressRich: await makeMeRichPromise,
	}
}

export const requestActiveAddresses = async () => ({ method: 'popup_requestActiveAddresses' as const, activeAddresses: await getActiveAddresses() })

export const requestSimulationMode = async () => ({ method: 'popup_requestSimulationMode' as const, simulationMode: (await getSettings()).simulationMode })

export const requestLatestUnexpectedError = async () => ({ method: 'popup_requestLatestUnexpectedError' as const, latestUnexpectedError: await getLatestUnexpectedError() })

async function getCachedRichData() {
	const [makeCurrentAddressRich, fixedAddressRichList] = await Promise.all([
		getMakeCurrentAddressRich(),
		getFixedAddressRichList(),
	])
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedAddressRichList.map(async(element) => (
			{ ...element, addressBookEntry: await getActiveAddressEntry(element.address) }
		))),
		makeCurrentAddressRich,
	}
}

async function buildHomePageUpdate(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	{
		requestAbortController,
		richDataSource,
		shouldRefreshSignerAccounts,
	}: {
		requestAbortController?: AbortController
		richDataSource: 'cached' | 'fresh'
		shouldRefreshSignerAccounts: boolean
	}
): Promise<UpdateHomePage> {
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const preSimulationBlockTimeManipulationPromise = silenceChromeUnCaughtPromise(getPreSimulationBlockTimeManipulation())
	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = silenceChromeUnCaughtPromise(getPopupVisualisationState())
	const activeAddressesPromise = silenceChromeUnCaughtPromise(getActiveAddresses())
	const latestUnexpectedErrorPromise = silenceChromeUnCaughtPromise(getLatestUnexpectedError())
	const richDataPromise = silenceChromeUnCaughtPromise(
		richDataSource === 'fresh'
			? requestMakeMeRichList(ethereum, requestAbortController)
			: getCachedRichData()
	)
	const tabId = await getLastKnownCurrentTabId()
	const tabStatePromise = silenceChromeUnCaughtPromise(tabId === undefined ? getTabState(-1) : getTabState(tabId))
	const settings = await settingsPromise
	let tabState = await tabStatePromise
	tabState = await refreshSignerAccountsForTabIfNeeded(websiteTabConnections, tabId, tabState, shouldRefreshSignerAccounts)
	const websiteOrigin = tabState.website?.websiteOrigin
	const interceptorDisabled = websiteOrigin === undefined ? false : hasAccess(settings.websiteAccess, websiteOrigin) === 'interceptorDisabled'
	const richData = await richDataPromise
	return {
		method: 'popup_UpdateHomePage' as const,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			activeAddresses: await activeAddressesPromise,
			richList: richData.richList,
			makeCurrentAddressRich: richData.makeCurrentAddressRich,
			latestUnexpectedError: await latestUnexpectedErrorPromise,
			websiteAccessAddressMetadata: await getAddressMetadataForAccess(settings.websiteAccess),
			tabState,
			activeSigningAddressInThisTab: tabState.activeSigningAddress,
			currentBlockNumber: ethereum.getCachedBlock()?.number,
			settings,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
			preSimulationBlockTimeManipulation: await preSimulationBlockTimeManipulationPromise,
		}
	}
}

export async function fetchSimulationStackRequestConfirmation(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	const simulationState = await getUpdatedSimulationState(ethereumClientService)
	await resolveFetchSimulationStackRequest(simulationState, websiteTabConnections, confirmation)
}

export async function handleUnexpectedErrorInWindow(parsedRequest: UnexpectedErrorOccured) {
	return handleUnexpectedError(new Error(parsedRequest.data.message), {
		source: parsedRequest.data.source,
		code: parsedRequest.data.code,
	})
}

export async function requestInterceptorSimulationInput(ethereumClientService: EthereumClientService) {
	const stackPromise = silenceChromeUnCaughtPromise(getInterceptorTransactionStack())
	const simulationInput = await getCurrentSimulationInput()
	const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereumClientService.getBlockNumber(undefined))
	const eth_simulateV1 = await ethereumClientService.ethSimulateV1Input(simulationInput, await currentBlockNumberPromise, undefined)
	const stack = await stackPromise

	const interceptorSimulateStack = modifyObject(stack, { operations: stack.operations.map((operation) => {
		switch(operation.type) {
			case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { website: { ...operation.signedMessageTransaction.website, icon: undefined, title: undefined } }) })
			case 'TimeManipulation': return operation
			case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { website: { ...operation.preSimulationTransaction.website, icon: undefined, title: undefined } }) })
			default: return assertNever(operation)
		}
	}) })
	return { method: 'popup_requestInterceptorSimulationInput' as const, ethSimulateV1InputString:
		JSON.stringify(
			InterceptorSimulationExport.serialize({
				name: 'Interceptor Simulation Export',
				version: '1.0.0',
				eth_simulateV1,
				interceptorSimulateStack,
			})
		, null, '\t')
	}
}

export async function importSimulationStack(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ImportSimulationStack): Promise<ImportSimulationStackReply> {
	if (parsedRequest.data.version !== '1.0.0') return importSimulationStackFailure('Only simulation stack export version 1.0.0 is supported.')
	if (parsedRequest.data.interceptorSimulateStack.operations.length === 0) return importSimulationStackSuccess()

	const importedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, parsedRequest.data.interceptorSimulateStack)
	console.info(`[simulation-stack import] received ${ parsedRequest.data.interceptorSimulateStack.operations.length } operations (${ formatEstimatedBytes(importedStackBytes) }).`)

	const websiteAccess = await getWebsiteAccess()
	const updateWebsiteDetails = (website: Website) => {
		const websiteData = websiteAccess.find((access) => access.website.websiteOrigin === website.websiteOrigin)?.website
		return websiteData ?? website
	}

	let updatedStack: InterceptorTransactionStack
	try {
		updatedStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			const newOperations = [...prevStack.operations, ...parsedRequest.data.interceptorSimulateStack.operations]
			// generate new ids for operations to prevent duplicated ids
			return { operations: normalizeConsecutiveTimeManipulations(newOperations.map((operation) => {
				switch(operation.type) {
					case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { messageIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.signedMessageTransaction.website) }) })
					case 'TimeManipulation': return operation
					case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { transactionIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.preSimulationTransaction.website) }) })
					default: return assertNever(operation)
				}
			})) }
		})
	} catch (error) {
		return importSimulationStackFailure(`Failed to store the imported simulation stack (${ formatEstimatedBytes(importedStackBytes) }): ${ getErrorMessage(error) }`)
	}

	const updatedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, updatedStack)
	console.info(`[simulation-stack import] persisted transaction stack at ${ formatEstimatedBytes(updatedStackBytes) }.`)

	try {
		await updatePopupVisualisationState(ethereum, tokenPriceService, undefined, true)
		const popupVisualisation = await getPopupVisualisationState()
		const popupVisualisationBytes = estimateSerializedStateBytes(CompleteVisualizedSimulation, popupVisualisation)
		console.info(`[simulation-stack import] persisted popup visualisation at ${ formatEstimatedBytes(popupVisualisationBytes) }.`)
	} catch (error) {
		return importSimulationStackFailure(`Imported stack was stored (${ formatEstimatedBytes(updatedStackBytes) }), but updating the visualized simulation failed: ${ getErrorMessage(error) }`)
	}

	return importSimulationStackSuccess()
}

export async function requestCompleteVisualizedSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const visualizedSimulatorState = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
	return { method: 'popup_requestCompleteVisualizedSimulation' as const, visualizedSimulatorState }
}

export async function requestSimulationMetadata(ethereumClientService: EthereumClientService) {
	const settings = await getSettings()
	const simulationState = settings.simulationMode ? await getUpdatedSimulationState(ethereumClientService) : { kind: 'passthrough' as const }
	if (simulationState.kind === 'passthrough' || simulationState.value.success === false) return {
		method: 'popup_requestSimulationMetadata' as const,
		metadata: {
			namedTokenIds: [], addressBookEntries: [], ens: { ensNameHashes: [], ensLabelHashes: [] }
		}
	}
	const eventsForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) =>
			Promise.all(block.simulatedTransactions.map(
				async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereumClientService, undefined)
			))
		)
	))
	const parsedInputDataForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) => {
			const transactions = getWebsiteCreatedEthereumUnsignedTransactions(block.simulatedTransactions)
			return Promise.all(transactions.map((transaction) =>
				parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereumClientService, undefined)
			))
		})
	))
	const events = (await eventsForEachBlockAndTransactionPromise).flat()
	const inputData = (await parsedInputDataForEachBlockAndTransactionPromise).flat()

	const metadata = await getMetadataForSimulation(simulationState.value, ethereumClientService, undefined, events, inputData)
	return { method: 'popup_requestSimulationMetadata' as const, metadata }
}

export async function requestIdentifyAddress(ethereumClientService: EthereumClientService, parsedRequest: RequestIdentifyAddress) {
	return { method: 'popup_requestIdentifyAddress' as const, data: { addressBookEntry: await identifyAddress(ethereumClientService, undefined, parsedRequest.data.address) } }
}

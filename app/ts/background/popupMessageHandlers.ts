import { changeActiveAddressAndChain, changeActiveRpc, refreshConfirmTransactionSimulation, updateSimulationState } from './background.js'
import { getSettings, setUseTabsInsteadOfPopup, setMakeMeRich, setPage, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, exportSettingsAndAddressBook, importSettingsAndAddressBook, getMakeMeRich, getUseTabsInsteadOfPopup, getMetamaskCompatibilityMode, setMetamaskCompatibilityMode, getPage, setPreSimulationBlockTimeManipulation, getPreSimulationBlockTimeManipulation, getMakeMeRichList, setMakeMeRichList, getKeepSelectedAddressRichEvenIfIChangeAddress, setKeepSelectedAddressRichEvenIfIChangeAddress } from './settings.js'
import { getPendingTransactionsAndMessages, getCurrentTabId, getTabState, saveCurrentTabId, setRpcList, getRpcList, getPrimaryRpcForChain, getRpcConnectionStatus, updateUserAddressBookEntries, getSimulationResults, setIdsOfOpenedTabs, getIdsOfOpenedTabs, updatePendingTransactionOrMessage, addEnsLabelHash, addEnsNodeHash, updateInterceptorTransactionStack, getLatestUnexpectedError } from './storageVariables.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ModifyMakeMeRich, ChangePage, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, InterceptorAccessRefresh, InterceptorAccessChangeAddress, Settings, ChangeSettings, ImportSettings, SetRpcList, UpdateHomePage, SimulateGovernanceContractExecution, ChangeAddOrModifyAddressWindowState, FetchAbiAndNameFromBlockExplorer, OpenWebPage, DisableInterceptor, SetEnsNameForHash, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions, SimulateExecutionReply, BlockOrAllowExternalRequests, RemoveWebsiteAccess, AllowOrPreventAddressAccessForWebsite, RemoveWebsiteAddressAccess, ForceSetGasLimitForTransaction, RetrieveWebsiteAccess, ChangePreSimulationBlockTimeManipulation, SetTransactionOrMessageBlockTimeManipulator } from '../types/interceptor-messages.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransactionOrMessage, updateConfirmTransactionView, setGasLimitForTransaction } from './windows/confirmTransaction.js'
import { getAddressMetadataForAccess, requestAddressChange, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { sendMessageToApprovedWebsitePorts, setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from './medataSearch.js'
import { getActiveAddresses, identifyAddress } from './metadataUtils.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { CompleteVisualizedSimulation, InterceptorStackOperation, InterceptorTransactionStack, ModifyAddressWindowState } from '../types/visualizer-types.js'
import { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { isJSON } from '../utils/json.js'
import { AddressBookEntry, IncompleteAddressBookEntry } from '../types/addressBookTypes.js'
import { EthereumAddress, serialize } from '../types/wire-types.js'
import { fetchAbiFromBlockExplorer, isValidAbi } from '../simulation/services/EtherScanAbiFetcher.js'
import { stringToAddress } from '../utils/bigint.js'
import { ethers } from 'ethers'
import { getIssueWithAddressString } from '../components/ui-utils.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { Website } from '../types/websiteAccessTypes.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { checkAndThrowRuntimeLastError, updateTabIfExists } from '../utils/requests.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { searchWebsiteAccess } from './websiteAccessSearch.js'
import { simulateGnosisSafeMetaTransaction, simulateGovernanceContractExecution, updateSimulationMetadata, visualizeSimulatorState } from './simulationUpdating.js'
import { isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { RequestActiveAddressesReply, RequestLatestUnexpectedErrorReply, RequestMakeMeRichDataReply, RequestSimulationModeReply } from '../types/interceptor-reply-messages.js'

export async function confirmDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	await resolvePendingTransactionOrMessage(simulator, websiteTabConnections, confirmation)
}

export async function confirmRequestAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess(simulator, websiteTabConnections, confirmation.data)
}

export async function getLastKnownCurrentTabId() {
	const tabIdPromise = getCurrentTabId()
	const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true })
	const tabId = await tabIdPromise
	// skip restricted or insufficient permission tabs
	if (tabs[0]?.id === undefined || tabs[0]?.url === undefined) return tabId
	if (tabId !== tabs[0].id) saveCurrentTabId(tabs[0].id)
	return tabs[0].id
}

async function getSignerAccount() {
	const tabId = await getLastKnownCurrentTabId()
	const signerAccounts = tabId === undefined ? undefined : (await getTabState(tabId)).signerAccounts
	return signerAccounts !== undefined && signerAccounts.length > 0 ? signerAccounts[0] : undefined
}

export async function changeActiveAddress(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, addressChange: ChangeActiveAddress) {
	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if (addressChange.data.activeAddress === 'signer') {
		const signerAccount = await getSignerAccount()
		await setUseSignersAddressAsActiveAddress(addressChange.data.activeAddress === 'signer', signerAccount)
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })

		await changeActiveAddressAndChain(simulator, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: signerAccount,
		})
	} else {
		await setUseSignersAddressAsActiveAddress(false)
		await changeActiveAddressAndChain(simulator, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: addressChange.data.activeAddress,
		})
	}
}

export async function modifyMakeMeRich(simulator: Simulator, makeMeRichChange: ModifyMakeMeRich) {
	if (makeMeRichChange.data.address === 'KeepSelectedAddressRichEvenIfIChangeAddress') {
		return await setKeepSelectedAddressRichEvenIfIChangeAddress(makeMeRichChange.data.add)
	}
	else if (makeMeRichChange.data.address === 'CurrentAddress') {
		await setMakeMeRich(makeMeRichChange.data.add)
	} else {
		const currentList = await getMakeMeRichList()
		if (makeMeRichChange.data.add) {
			await setMakeMeRichList([...currentList, makeMeRichChange.data.address])
		} else {
			await setMakeMeRichList(currentList.filter((address) => address !== makeMeRichChange.data.address))
		}
	}
	await refreshSimulation(simulator, true)
}

export async function removeAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => previousContacts.filter((contact) =>
		!(contact.address === removeAddressBookEntry.data.address
		&& (contact.chainId === removeAddressBookEntry.data.chainId || (contact.chainId === undefined && removeAddressBookEntry.data.chainId === 1n))))
	)
	if (removeAddressBookEntry.data.addressBookCategory === 'My Active Addresses') updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function addOrModifyAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => {
		if (previousContacts.find((previous) => previous.address === entry.data.address && (previous.chainId || 1n) === (entry.data.chainId || 1n)) ) {
			return previousContacts.map((previous) => previous.address === entry.data.address && (previous.chainId || 1n) === (entry.data.chainId || 1n) ? entry.data : previous)
		}
		return previousContacts.concat([entry.data])
	})
	if (entry.data.useAsActiveAddress) updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function changeInterceptorAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
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

	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export const changePage = async (page: ChangePage) => await setPage(page.data)

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

export async function removeTransactionOrSignedMessage(simulator: Simulator, params: RemoveTransaction) {
	const removeConsequtiveTimeManipulations = (operations: readonly InterceptorStackOperation[]) => {
		return operations.filter((operation, operationIndex) => !(operationIndex > 0 && operation.type === 'TimeManipulation' && operations[operationIndex - 1]?.type === 'TimeManipulation'))
	}
	await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		switch (params.data.type) {
			case 'Transaction': {
				const transactionIdentifier = params.data.transactionIdentifier
				const transactionToBeRemoved = prevStack.operations.find((transaction) => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
				if (transactionToBeRemoved === undefined) return prevStack

				const newOperations: InterceptorStackOperation[] = []
				let transactionWasFound = false
				for (const operation of prevStack.operations) {
					if (operation.type === 'Transaction' && transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier) {
						transactionWasFound = true
						continue
					}
					if (operation.type === 'Transaction') {
						const transaction = operation.preSimulationTransaction
						const shouldUpdateNonce = transactionWasFound && transactionToBeRemoved.type === 'Transaction' && transaction.signedTransaction.from === transactionToBeRemoved.preSimulationTransaction.signedTransaction.from
						const newTransaction = modifyObject(transaction.signedTransaction, shouldUpdateNonce ? { nonce: transaction.signedTransaction.nonce - 1n } : {})
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
				return { operations: removeConsequtiveTimeManipulations(newOperations) }
			}
			case 'Message': {
				const messageIdentifier = params.data.messageIdentifier
				return {
					operations: removeConsequtiveTimeManipulations(prevStack.operations)
						.filter((operation) => !(operation.type === 'Message' && messageIdentifier === operation.signedMessageTransaction.messageIdentifier))
				}
			}
			default: assertNever(params.data)
		}
	})

	await updateSimulationState(simulator.ethereum, simulator.tokenPriceService, true)
}

export async function refreshSimulation(simulator: Simulator, refreshOnlyIfNotAlreadyUpdatingSimulation: boolean) {
	return await updateSimulationState(simulator.ethereum, simulator.tokenPriceService, false, refreshOnlyIfNotAlreadyUpdatingSimulation)
}

export async function refreshPopupConfirmTransactionMetadata(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, tokenPriceService: TokenPriceService) {
	const currentBlockNumberPromise = ethereumClientService.getBlockNumber(requestAbortController)
	const promises = await getPendingTransactionsAndMessages()
	const visualizedSimulatorStatePromise = getSimulationResults()
	const first = promises[0]
	if (first === undefined) return
	switch (first.type) {
		case 'SignableMessage': {
			const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereumClientService, requestAbortController, first.signedMessageTransaction, ethereumClientService.getRpcEntry())
			const message: UpdateConfirmTransactionDialog = {
				method: 'popup_update_confirm_transaction_dialog',
				data: {
					visualizedSimulatorState: await visualizedSimulatorStatePromise,
					currentBlockNumber: await currentBlockNumberPromise,
				}
			}
			const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
				data: {
					pendingTransactionAndSignableMessages: [{
						...first,
						visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise,
						transactionOrMessageCreationStatus: 'Simulated' as const
					}, ...promises.slice(1)],
					currentBlockNumber: await currentBlockNumberPromise,
				}
			}
			return await Promise.all([
				sendPopupMessageToOpenWindows(messagePendingTransactions),
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message))
			])
		}
		case 'Transaction': {
			if (first.transactionOrMessageCreationStatus !== 'Simulated' || first.simulationResults.statusCode === 'failed') return
			try {
				const visualizedSimulationState = await visualizeSimulatorState(first.simulationResults.data.simulationState, ethereumClientService, tokenPriceService, requestAbortController)
				const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
					data: {
						pendingTransactionAndSignableMessages: [
							modifyObject(first,
								{
									simulationResults: {
										statusCode: 'success',
										data: modifyObject(first.simulationResults.data, { ...visualizedSimulationState })
									}
								})
							, ...promises.slice(1)],
						currentBlockNumber: await currentBlockNumberPromise,
					}
				}
				const message: UpdateConfirmTransactionDialog = {
					method: 'popup_update_confirm_transaction_dialog' as const,
					data: {
						visualizedSimulatorState: await visualizedSimulatorStatePromise,
						currentBlockNumber: await currentBlockNumberPromise,
					}
				}
				return await Promise.all([
					sendPopupMessageToOpenWindows(messagePendingTransactions),
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message))
				])
			} catch(error: unknown) {
				if (error instanceof Error && isNewBlockAbort(error)) return
				if (error instanceof Error && isFailedToFetchError(error)) return
				throw error
			}
		}
		default: assertNever(first)
	}
}

export async function refreshPopupConfirmTransactionSimulation(simulator: Simulator) {
	const [firstTxn] = await getPendingTransactionsAndMessages()
	if (firstTxn === undefined || firstTxn.type !== 'Transaction' || (firstTxn.transactionOrMessageCreationStatus !== 'Simulated' && firstTxn.transactionOrMessageCreationStatus !== 'FailedToSimulate')) return
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction' ? await formEthSendTransaction(simulator.ethereum, undefined, firstTxn.activeAddress, firstTxn.transactionToSimulate.website, firstTxn.originalRequestParameters, firstTxn.created, firstTxn.transactionIdentifier, firstTxn.simulationMode) : await formSendRawTransaction(simulator.ethereum, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created, firstTxn.transactionIdentifier)
	const refreshMessage = await refreshConfirmTransactionSimulation(simulator, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.uniqueRequestIdentifier, transactionToSimulate)
	if (refreshMessage === undefined) return
	await updatePendingTransactionOrMessage(firstTxn.uniqueRequestIdentifier, async (transactionOrMessage) => {
		switch (transactionOrMessage.type) {
			case 'SignableMessage': throw new Error('Tried to refresh simulation of a message')
			case 'Transaction': {
				if (transactionToSimulate.success) {
					return { ...transactionOrMessage, transactionToSimulate, simulationResults: refreshMessage, transactionOrMessageCreationStatus: 'Simulated' }
				} else {
					return { ...transactionOrMessage, transactionToSimulate, simulationResults: refreshMessage, transactionOrMessageCreationStatus: 'FailedToSimulate' }
				}
			}
			default: assertNever(transactionOrMessage)
		}
	})
	await updateConfirmTransactionView(simulator.ethereum)
}

export async function popupChangeActiveRpc(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, params: ChangeActiveChain, settings: Settings) {
	return await changeActiveRpc(simulator, websiteTabConnections, params.data, settings.simulationMode)
}

export async function changeChainDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(simulator, websiteTabConnections, chainChange)
}

export async function enableSimulationMode(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, params: EnableSimulationMode) {
	const settings = await getSettings()
	// if we are on unsupported chain, force change to a supported one
	if (settings.useSignersAddressAsActiveAddress || params.data === false) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
		const tabId = await getLastKnownCurrentTabId()
		const chainToSwitch = tabId === undefined ? undefined : (await getTabState(tabId)).signerChain
		const networkToSwitch = chainToSwitch === undefined ? (await getRpcList())[0] : await getPrimaryRpcForChain(chainToSwitch)
		await changeActiveAddressAndChain(simulator, websiteTabConnections, {
			simulationMode: params.data,
			activeAddress: await getSignerAccount(),
			...chainToSwitch === undefined ? {} : { rpcNetwork: networkToSwitch },
		})
	} else {
		const selectedNetworkToSwitch = settings.activeRpcNetwork.httpsRpc !== undefined ? settings.activeRpcNetwork : (await getRpcList())[0]
		await changeActiveAddressAndChain(simulator, websiteTabConnections, {
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

export async function requestNewHomeData(simulator: Simulator, requestAbortController: AbortController | undefined) {
	const settings = await getSettings()
	if (settings.simulationMode) await updateSimulationMetadata(simulator.ethereum, requestAbortController)
	await refreshHomeData(simulator)
}

export async function refreshHomeData(simulator: Simulator) {
	const settingsPromise = getSettings()
	const rpcConnectionStatusPromise = getRpcConnectionStatus()
	const rpcEntriesPromise = getRpcList()
	const preSimulationBlockTimeManipulationPromise = getPreSimulationBlockTimeManipulation()

	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = getSimulationResults()
	const tabId = await getLastKnownCurrentTabId()
	const tabState = tabId === undefined ? await getTabState(-1) : await getTabState(tabId)
	const settings = await settingsPromise
	if (settings.activeRpcNetwork.httpsRpc !== undefined) makeSureInterceptorIsNotSleeping(simulator.ethereum)
	const websiteOrigin = tabState.website?.websiteOrigin
	const interceptorDisabled = websiteOrigin === undefined ? false : settings.websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin && entry.interceptorDisabled === true) !== undefined
	const updatedPage: UpdateHomePage = {
		method: 'popup_UpdateHomePage' as const,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			websiteAccessAddressMetadata: await getAddressMetadataForAccess(settings.websiteAccess),
			tabState,
			activeSigningAddressInThisTab: tabState?.activeSigningAddress,
			currentBlockNumber: simulator.ethereum.getCachedBlock()?.number,
			settings: settings,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
			preSimulationBlockTimeManipulation: await preSimulationBlockTimeManipulationPromise
		}
	}
	await sendPopupMessageToOpenWindows(serialize(UpdateHomePage, updatedPage))
}

export async function settingsOpened() {
	const useTabsInsteadOfPopupPromise = getUseTabsInsteadOfPopup()
	const metamaskCompatibilityModePromise = getMetamaskCompatibilityMode()
	const rpcEntriesPromise = getRpcList()
	const settingsPromise = getSettings()

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

export async function changeSettings(simulator: Simulator, parsedRequest: ChangeSettings, requestAbortController: AbortController | undefined) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	return await requestNewHomeData(simulator, requestAbortController)
}

export async function importSettings(settingsData: ImportSettings) {
	if (!isJSON(settingsData.data.fileContents)) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_initiate_export_settings_reply',
			data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' }
		})
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_initiate_export_settings_reply',
			data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' }
		})
	}
	await importSettingsAndAddressBook(parsed.value)
	return await sendPopupMessageToOpenWindows({
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

export async function setNewRpcList(simulator: Simulator, request: SetRpcList, settings: Settings) {
	await setRpcList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	const primary = await getPrimaryRpcForChain(settings.activeRpcNetwork.chainId)
	if (primary !== undefined) {
		// reset to primary on update
		simulator.reset(primary)
	}
}

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, request: SimulateGovernanceContractExecution) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const transaction = pendingTransactions.find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === request.data.transactionIdentifier)
	if (transaction === undefined || transaction.type !== 'Transaction') throw new Error(`Could not find transactionIdentifier: ${ request.data.transactionIdentifier }`)
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(transaction, ethereum, tokenPriceService)
	return await sendPopupMessageToOpenWindows(serialize(SimulateExecutionReply, {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...governanceContractExecutionVisualisation, transactionOrMessageIdentifier: request.data.transactionIdentifier }
	}))
}

export async function simulateGnosisSafeTransactionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) {
	const simulationResults = await getSimulationResults()
	const gnosisTransactionExecutionVisualisation = await simulateGnosisSafeMetaTransaction(gnosisSafeMessage, simulationResults.simulationState, ethereum, tokenPriceService)
	return await sendPopupMessageToOpenWindows(serialize(SimulateExecutionReply, {
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
		if (ethers.isAddress(trimmed)) {
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

	const identifyAddressCandidate = async (addressCandidate: string | undefined) => {
		if (addressCandidate === undefined) return undefined
		const address = EthereumAddress.safeParse(addressCandidate.trim())
		if (address.success === false) return undefined
		return await identifyAddress(ethereum, undefined, address.value)
	}
	const identifyPromise = identifyAddressCandidate(parsedRequest.data.newState.incompleteAddressBookEntry.address)
	const message = await getErrorIfAnyWithIncompleteAddressBookEntry(ethereum, parsedRequest.data.newState.incompleteAddressBookEntry)

	const errorState = message === undefined ? undefined : { blockEditing: true, message }
	if (errorState?.message !== parsedRequest.data.newState.errorState?.message) await updatePage({ ...parsedRequest.data.newState, errorState })
	return await sendPopupMessageToOpenWindows({
		method: 'popup_addOrModifyAddressWindowStateInformation',
		data: { windowStateId: parsedRequest.data.windowStateId, errorState: errorState, identifiedAddress: await identifyPromise }
	})
}

export async function popupfetchAbiAndNameFromBlockExplorer(parsedRequest: FetchAbiAndNameFromBlockExplorer) {
	const etherscanReply = await fetchAbiFromBlockExplorer(parsedRequest.data.address, parsedRequest.data.chainId)
	if (etherscanReply.success) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_fetchAbiAndNameFromBlockExplorerReply' as const,
			data: {
				windowStateId: parsedRequest.data.windowStateId,
				success: true,
				address: parsedRequest.data.address,
				abi: etherscanReply.abi,
				contractName: etherscanReply.contractName,
			}
		})
	}
	return await sendPopupMessageToOpenWindows({
		method: 'popup_fetchAbiAndNameFromBlockExplorerReply' as const,
		data: {
			windowStateId: parsedRequest.data.windowStateId,
			success: false,
			address: parsedRequest.data.address,
			error: etherscanReply.error
		}
	})
}

export async function openWebPage(parsedRequest: OpenWebPage) {
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === parsedRequest.data.websiteSocket.tabId)
	if (addressBookTab === undefined) return await browser.tabs.create({ url: parsedRequest.data.url, active: true })
	try {
		browser.tabs.update(parsedRequest.data.websiteSocket.tabId, { url: parsedRequest.data.url, active: true })
		checkAndThrowRuntimeLastError()
	} catch (error) {
		console.warn('Failed to update tab with new webpage')
		// biome-ignore lint/suspicious/noConsoleLog: <used for support debugging>
		console.log({ error })
	}
	finally {
		return await browser.tabs.create({ url: parsedRequest.data.url, active: true })
	}
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

export async function disableInterceptor(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await disableInterceptorForPage(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function setEnsNameForHash(parsedRequest: SetEnsNameForHash) {
	if (parsedRequest.data.type === 'labelHash') {
		await addEnsLabelHash(parsedRequest.data.name)
	} else {
		await addEnsNodeHash(parsedRequest.data.name)
	}
	return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess)

	await sendPopupMessageToOpenWindows({
		method: 'popup_retrieveWebsiteAccessReply',
		data: {
			websiteAccess,
			addressAccessMetadata
		}
	})
}

async function blockOrAllowWebsiteExternalRequests(websiteTabConnections: WebsiteTabConnections, website: Website, shouldBlock: boolean) {
	await updateWebsiteAccess((previousAccessList) => {
		return previousAccessList.map((access) => {
			if (access.website.websiteOrigin !== website.websiteOrigin) return access
			return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
		})
	})

	await reloadConnectedTabs(websiteTabConnections)
}

export async function blockOrAllowExternalRequests(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await blockOrAllowWebsiteExternalRequests(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.shouldBlock)
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
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

export async function removeWebsiteAddressAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await removeAddressAccessByAddress(parsedRequest.data.websiteOrigin, parsedRequest.data.address)
	await reloadConnectedTabs(websiteTabConnections)
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
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
	return await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	await updateWebsiteAccess((previousAccess) => previousAccess.filter(access => access.website.websiteOrigin !== parsedRequest.data.websiteOrigin))
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}
export async function forceSetGasLimitForTransaction(simulator: Simulator, parsedRequest: ForceSetGasLimitForTransaction) {
	await setGasLimitForTransaction(parsedRequest.data.transactionIdentifier, parsedRequest.data.gasLimit)
	await refreshPopupConfirmTransactionSimulation(simulator)
}

export async function changePreSimulationBlockTimeManipulation(simulator: Simulator, parsedRequest: ChangePreSimulationBlockTimeManipulation) {
	await setPreSimulationBlockTimeManipulation(parsedRequest.data.blockTimeManipulation)
	await refreshSimulation(simulator, true)
}

export async function setTransactionOrMessageBlockTimeManipulator(simulator: Simulator, parsedRequest: SetTransactionOrMessageBlockTimeManipulator) {
	await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		const identifier = parsedRequest.data.transactionOrMessageIdentifier
		const appendAfterIndex = prevStack.operations.findIndex((operation) => {
			switch(operation.type) {
				case 'Transaction': return identifier.type === operation.type && identifier.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
				case 'Message': return identifier.type === operation.type && identifier.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
				case 'TimeManipulation': return false
				default: assertNever(operation)
			}
		})
		if (appendAfterIndex < 0) return prevStack
		const indexOfMaybeManipulator = appendAfterIndex + 1
		const maybeExistingManipulator = prevStack.operations[indexOfMaybeManipulator]
		if (maybeExistingManipulator?.type === 'TimeManipulation') {
			// no delay, so we can remove the manipulator
			if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return { operations: [...prevStack.operations.slice(0, indexOfMaybeManipulator), ...prevStack.operations.slice(indexOfMaybeManipulator + 1)] }
			const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
			// replace manipulator
			return { operations: prevStack.operations.map((operation, index) => index === indexOfMaybeManipulator ? newManipulator : operation) }
		}
		// insert new manipulator
		if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return prevStack
		const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
		return { operations: [...prevStack.operations.slice(0, indexOfMaybeManipulator), newManipulator, ...prevStack.operations.slice(indexOfMaybeManipulator)] }
	})

	await refreshSimulation(simulator, true)
}

export async function requestMakeMeRichList(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined,) {
	const keepSelectedAddressRichEvenIfIChangeAddressPromise = getKeepSelectedAddressRichEvenIfIChangeAddress()
	const makeMeRichPromise = getMakeMeRich()
	const richList = await getMakeMeRichList()
	const addressbookEntryPromises: Promise<AddressBookEntry>[] = Array.from(richList.values()).map((address) => identifyAddress(ethereumClientService, requestAbortController, address))
	return RequestMakeMeRichDataReply.serialize({
		richList: await Promise.all(addressbookEntryPromises),
		keepSelectedAddressRichEvenIfIChangeAddress : await keepSelectedAddressRichEvenIfIChangeAddressPromise,
		makeMeRich: await makeMeRichPromise
	})
}

export const requestActiveAddresses = async () => RequestActiveAddressesReply.serialize({ activeAddresses: await getActiveAddresses() })

export const requestSimulationMode = async () => RequestSimulationModeReply.serialize({ simulationMode: (await getSettings()).simulationMode })

export const requestLatestUnexpectedError = async () => RequestLatestUnexpectedErrorReply.serialize({ latestUnexpectedError: await getLatestUnexpectedError() })

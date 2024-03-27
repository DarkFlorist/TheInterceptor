import { changeActiveAddressAndChainAndResetSimulation, changeActiveRpc, getPrependTransactions, refreshConfirmTransactionSimulation, updateSimulationState, updateSimulationMetadata, simulateGovernanceContractExecution } from './background.js'
import { getSettings, setUseTabsInsteadOfPopup, setMakeMeRich, setPage, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, exportSettingsAndAddressBook, importSettingsAndAddressBook, getMakeMeRich, getUseTabsInsteadOfPopup, getMetamaskCompatibilityMode, setMetamaskCompatibilityMode, getPage } from './settings.js'
import { getPendingTransactionsAndMessages, getCurrentTabId, getTabState, saveCurrentTabId, setRpcList, getRpcList, getPrimaryRpcForChain, getRpcConnectionStatus, updateUserAddressBookEntries, getSimulationResults, setIdsOfOpenedTabs, getIdsOfOpenedTabs, updatePendingTransactionOrMessage } from './storageVariables.js'
import { Simulator, parseEvents } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeMakeMeRich, ChangePage, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, InterceptorAccessRefresh, InterceptorAccessChangeAddress, Settings, RefreshConfirmTransactionMetadata, ChangeSettings, ImportSettings, SetRpcList, UpdateHomePage, SimulateGovernanceContractExecutionReply, SimulateGovernanceContractExecution, ChangeAddOrModifyAddressWindowState, FetchAbiAndNameFromEtherscan, OpenWebPage, DisableInterceptor } from '../types/interceptor-messages.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { getAddressMetadataForAccess, requestAddressChange, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { sendMessageToApprovedWebsitePorts, setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from './medataSearch.js'
import { getActiveAddresses, getAddressBookEntriesForVisualiser, identifyAddress, nameTokenIds } from './metadataUtils.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { refreshSimulationState, removeSignedMessageFromSimulation, removeTransactionAndUpdateTransactionNonces, resetSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { CompleteVisualizedSimulation, ModifyAddressWindowState, SimulationState } from '../types/visualizer-types.js'
import { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { isJSON } from '../utils/json.js'
import { IncompleteAddressBookEntry } from '../types/addressBookTypes.js'
import { EthereumAddress, serialize } from '../types/wire-types.js'
import { fetchAbiFromEtherscan, isValidAbi } from '../simulation/services/EtherScanAbiFetcher.js'
import { stringToAddress } from '../utils/bigint.js'
import { ethers } from 'ethers'
import { getIssueWithAddressString } from '../components/ui-utils.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { Website } from '../types/websiteAccessTypes.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { checkAndThrowRuntimeLastError, updateTabIfExists } from '../utils/requests.js'

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
	if (tabs[0]?.id === undefined) return tabId
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
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] } )

		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: signerAccount,
		})
	} else {
		await setUseSignersAddressAsActiveAddress(false)
		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: addressChange.data.activeAddress,
		})
	}
}

export async function changeMakeMeRich(simulator: Simulator, ethereumClientService: EthereumClientService, makeMeRichChange: ChangeMakeMeRich, settings: Settings) {
	await setMakeMeRich(makeMeRichChange.data)
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return undefined
		const prependQueue = await getPrependTransactions(ethereumClientService, settings, makeMeRichChange.data)
		return await resetSimulationState(ethereumClientService, { ...simulationState, prependTransactionsQueue: prependQueue })
	}, settings.activeSimulationAddress, true)
}

export async function removeAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => previousContacts.filter((contact) => contact.address !== removeAddressBookEntry.data.address))
	if (removeAddressBookEntry.data.addressBookCategory === 'My Active Addresses') updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function addOrModifyAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => {
		if (previousContacts.find((x) => x.address === entry.data.address) ) {
			return previousContacts.map((x) => x.address === entry.data.address ? entry.data : x )
		}
		return previousContacts.concat([entry.data])
	})
	if (entry.data.type === 'activeAddress') updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function changeInterceptorAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess((previousAccess) => {
		const withEntriesRemoved = previousAccess.filter((acc) => accessChange.data.find((change) => change.newEntry.website.websiteOrigin ===  acc.website.websiteOrigin)?.removed !== true)
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

	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export const changePage = async (page: ChangePage) => await setPage(page.data)

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

export async function resetSimulation(simulator: Simulator, settings: Settings) {
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return undefined
		return await resetSimulationState(simulator.ethereum, simulationState)
	}, settings.activeSimulationAddress, true)
}

export async function removeTransactionOrSignedMessage(simulator: Simulator, ethereumClientService: EthereumClientService, params: RemoveTransaction, settings: Settings) {
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return
		if (params.data.type === 'MakeYouRichTransaction') return
		if (params.data.type === 'Transaction') return await removeTransactionAndUpdateTransactionNonces(ethereumClientService, simulationState, params.data.transactionIdentifier)
		return await removeSignedMessageFromSimulation(ethereumClientService, simulationState, params.data.messageIdentifier)
	}, settings.activeSimulationAddress, true)
}

export async function refreshSimulation(simulator: Simulator, settings: Settings, refreshOnlyIfNotAlreadyUpdatingSimulation: boolean): Promise<SimulationState | undefined> {
	return await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return
		return await refreshSimulationState(simulator.ethereum, simulationState)
	}, settings.activeSimulationAddress, false, refreshOnlyIfNotAlreadyUpdatingSimulation)
}

export async function refreshPopupConfirmTransactionMetadata(ethereumClientService: EthereumClientService, { data }: RefreshConfirmTransactionMetadata) {
	const currentBlockNumberPromise = ethereumClientService.getBlockNumber()
	const promises = await getPendingTransactionsAndMessages()
	const visualizedSimulatorStatePromise = getSimulationResults()
	const first = promises[0]
	if (first === undefined) return
	if (first.type === 'SignableMessage') {
		const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereumClientService, first.signedMessageTransaction, ethereumClientService.getRpcEntry())
		return await sendPopupMessageToOpenWindows({
			method: 'popup_update_confirm_transaction_dialog',
			data: {
				visualizedSimulatorState: await visualizedSimulatorStatePromise,
				currentBlockNumber: await currentBlockNumberPromise,
				pendingTransactionAndSignableMessages: [{
					...first,
					visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise, transactionOrMessageCreationStatus: 'Simulated' as const
				}, ...promises.slice(1)]
			}
		})
	}
	const eventsForEachTransaction = await Promise.all(data.eventsForEachTransaction.map(async(transactionsEvents) => await parseEvents(transactionsEvents.map((event) => event), ethereumClientService)))
	const addressBookEntriesPromise = getAddressBookEntriesForVisualiser(ethereumClientService, eventsForEachTransaction.flat(), data.simulationState)
	const namedTokenIdsPromise = nameTokenIds(ethereumClientService, eventsForEachTransaction.flat())
	const addressBookEntries = await addressBookEntriesPromise
	const namedTokenIds = await namedTokenIdsPromise
	if (first === undefined || first.transactionOrMessageCreationStatus !== 'Simulated' || first.simulationResults === undefined || first.simulationResults.statusCode !== 'success') return
	return await sendPopupMessageToOpenWindows({
		method: 'popup_update_confirm_transaction_dialog',
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			currentBlockNumber: await currentBlockNumberPromise,
			pendingTransactionAndSignableMessages: [{
				...first,
				simulationResults: {
					statusCode: 'success',
					data: {
						...first.simulationResults.data,
						simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransaction(first.simulationResults.data.simulationState, eventsForEachTransaction, first.simulationResults.data.protectors, addressBookEntries, namedTokenIds),
						addressBookEntries,
						eventsForEachTransaction,
					}
				}
			}, ...promises.slice(1)]
		}
	})
}

export async function refreshPopupConfirmTransactionSimulation(simulator: Simulator, ethereumClientService: EthereumClientService) {
	const [firstTxn] = await getPendingTransactionsAndMessages()
	if (firstTxn === undefined || firstTxn.type !== 'Transaction' || firstTxn.transactionOrMessageCreationStatus !== 'Simulated') return
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction' ? await formEthSendTransaction(ethereumClientService, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.transactionToSimulate.website, firstTxn.originalRequestParameters, firstTxn.created, firstTxn.transactionIdentifier) : await formSendRawTransaction(ethereumClientService, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created, firstTxn.transactionIdentifier)
	if (transactionToSimulate.success === false) return
	const refreshMessage = await refreshConfirmTransactionSimulation(simulator, ethereumClientService, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.uniqueRequestIdentifier, transactionToSimulate)

	await updatePendingTransactionOrMessage(firstTxn.uniqueRequestIdentifier, async (transaction) => ({...transaction, simulationResults: refreshMessage }))
	await updateConfirmTransactionView(ethereumClientService)
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
		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: params.data,
			activeAddress: await getSignerAccount(),
			...chainToSwitch === undefined ? {} :  { rpcNetwork: networkToSwitch },
		})
	} else {
		const selectedNetworkToSwitch = settings.currentRpcNetwork.httpsRpc !== undefined ? settings.currentRpcNetwork : (await getRpcList())[0]
		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: params.data,
			...settings.currentRpcNetwork === selectedNetworkToSwitch ? {} : { rpcNetwork: selectedNetworkToSwitch }
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

export const openNewTab = async (tabName: 'settingsView' | 'addressBook') => {
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: getHtmlFile(tabName) })
		if (tab.id !== undefined) await setIdsOfOpenedTabs({ [tabName]: tab.id })
	}

	const tabId = (await getIdsOfOpenedTabs())[tabName]
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	const tab = await updateTabIfExists(addressBookTab.id, { active: true })
	if (tab === undefined) await openInNewTab()
}

export async function requestNewHomeData(simulator: Simulator) {
	const settings = await getSettings()
	simulator.ethereum.setBlockPolling(true) // wakes up the RPC block querying if it was sleeping
	if (settings.simulationMode) await updateSimulationMetadata(simulator.ethereum)
	await refreshHomeData(simulator)
}

export async function refreshHomeData(simulator: Simulator) {
	makeSureInterceptorIsNotSleeping(simulator.ethereum)
	const settingsPromise = getSettings()
	const makeMeRichPromise = getMakeMeRich()
	const rpcConnectionStatusPromise = getRpcConnectionStatus()
	const rpcEntriesPromise = getRpcList()
	const activeAddressesPromise = getActiveAddresses()

	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = getSimulationResults()
	const tabId = await getLastKnownCurrentTabId()
	const tabState = tabId === undefined ? await getTabState(-1) : await getTabState(tabId)
	const settings = await settingsPromise
	if (settings.simulationMode) refreshSimulation(simulator, settings, true)
	const websiteOrigin = tabState.website?.websiteOrigin
	const interceptorDisabled = websiteOrigin === undefined ? false : settings.websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin && entry.interceptorDisabled === true) !== undefined
	const updatedPage: UpdateHomePage = {
		method: 'popup_UpdateHomePage' as const,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			activeAddresses: await activeAddressesPromise,
			websiteAccessAddressMetadata: await getAddressMetadataForAccess(settings.websiteAccess),
			tabState,
			activeSigningAddressInThisTab: tabState?.activeSigningAddress,
			currentBlockNumber: simulator.ethereum.getCachedBlock()?.number,
			settings: settings,
			makeMeRich: await makeMeRichPromise,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
		}
	}
	await sendPopupMessageToOpenWindows(serialize(UpdateHomePage, updatedPage))
}

export async function settingsOpened() {
	const useTabsInsteadOfPopupPromise = getUseTabsInsteadOfPopup()
	const metamaskCompatibilityModePromise = getMetamaskCompatibilityMode()
	const rpcEntriesPromise = getRpcList()

	await sendPopupMessageToOpenWindows({
		method: 'popup_settingsOpenedReply' as const,
		data: {
			useTabsInsteadOfPopup: await useTabsInsteadOfPopupPromise,
			metamaskCompatibilityMode: await metamaskCompatibilityModePromise,
			rpcEntries: await rpcEntriesPromise,
		}
	})
}

export async function interceptorAccessChangeAddressOrRefresh(websiteTabConnections: WebsiteTabConnections, params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(websiteTabConnections, params)
}

export async function changeSettings(simulator: Simulator, parsedRequest: ChangeSettings) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	return await requestNewHomeData(simulator)
}

export async function importSettings(settingsData: ImportSettings) {
	console.log(settingsData.data.fileContents)
	if (!isJSON(settingsData.data.fileContents)) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_initiate_export_settings_reply',
			data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSOn file.' }
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
	const primary = await getPrimaryRpcForChain(settings.currentRpcNetwork.chainId)
	if (primary !== undefined) {
		// reset to primary on update
		simulator?.reset(primary)
	}
}

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, request: SimulateGovernanceContractExecution) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const transaction = pendingTransactions.find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === request.data.transactionIdentifier)
	if (transaction === undefined || transaction.type !== 'Transaction') throw new Error(`Could not find transactionIdentifier: ${ request.data.transactionIdentifier }`)
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(transaction, ethereum)
	return await sendPopupMessageToOpenWindows(serialize(SimulateGovernanceContractExecutionReply, {
		method: 'popup_simulateGovernanceContractExecutionReply' as const,
		data: { ...governanceContractExecutionVisualisation, transactionIdentifier: request.data.transactionIdentifier }
	}))
}

const getErrorIfAnyWithIncompleteAddressBookEntry = async (ethereum: EthereumClientService, incompleteAddressBookEntry: IncompleteAddressBookEntry) => {
	// check for duplicates
	const duplicateEntry = await findEntryWithSymbolOrName(incompleteAddressBookEntry.symbol, incompleteAddressBookEntry.name)
	if (duplicateEntry !== undefined && duplicateEntry.address !== stringToAddress(incompleteAddressBookEntry.address)) {
		return `There already exists ${ duplicateEntry.type === 'activeAddress' ? 'an address' : duplicateEntry.type } with ${ 'symbol' in duplicateEntry ? `the symbol "${ duplicateEntry.symbol }" and` : '' } the name "${ duplicateEntry.name }".`
	}

	// check that address is valid
	if (incompleteAddressBookEntry.address !== undefined) {
		const trimmed = incompleteAddressBookEntry.address.trim()
		if (ethers.isAddress(trimmed)) {
			const address = EthereumAddress.parse(trimmed)
			if (incompleteAddressBookEntry.addingAddress) {
				const identifiedAddress = await identifyAddress(ethereum, address)
				if (identifiedAddress.entrySource !== 'OnChain' && identifiedAddress.entrySource !== 'FilledIn') {
					return `The address already exists. Edit the existing record instead trying to add it again.`
				}
				if (identifiedAddress.type !== incompleteAddressBookEntry.type && !(incompleteAddressBookEntry.type === 'activeAddress' && identifiedAddress.type === 'contact') ) {
					return `The address is a ${ identifiedAddress.type } while you are trying to add ${ incompleteAddressBookEntry.type }.`
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
	return await sendPopupMessageToOpenWindows({ method: 'popup_addOrModifyAddressWindowStateInformation',
		data: { windowStateId: parsedRequest.data.windowStateId, errorState: errorState }
	})
}

export async function popupFetchAbiAndNameFromEtherscan(parsedRequest: FetchAbiAndNameFromEtherscan) {
	const etherscanReply = await fetchAbiFromEtherscan(parsedRequest.data.address)
	if (etherscanReply.success) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_fetchAbiAndNameFromEtherscanReply' as const,
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
		method: 'popup_fetchAbiAndNameFromEtherscanReply' as const,
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
	} catch(e) {
		console.warn('Failed to update tab with new webpage')
		console.log(e)
	}
	finally {
		return await browser.tabs.create({ url: parsedRequest.data.url, active: true })
	}
}

async function disableInterceptorForPage(websiteTabConnections: WebsiteTabConnections, website: Website, interceptorDisabled: boolean) {
	await setInterceptorDisabledForWebsite(website, interceptorDisabled)
	if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3()
	else await updateContentScriptInjectionStrategyManifestV2()

	// reload all connected tabs of the same origin and the current webpage
	const tabIdsToRefesh = Array.from(websiteTabConnections.entries()).map(([tabId, _connection]) => tabId)
	const currentTabId = await getLastKnownCurrentTabId()
	const withCurrentTabid = currentTabId === undefined ? tabIdsToRefesh : [...tabIdsToRefesh, currentTabId]
	Array.from(new Set(withCurrentTabid)).forEach(async (tabId) => {
		try {
			await browser.tabs.reload(tabId)
			checkAndThrowRuntimeLastError()
		} catch (e) {
			console.warn('failed to reload tab')
			console.warn(e)
		}
	})
}

export async function disableInterceptor(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await disableInterceptorForPage(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

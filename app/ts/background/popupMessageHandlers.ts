import { changeActiveAddressAndChainAndResetSimulation, changeActiveRpc, getPrependTrasactions, refreshConfirmTransactionSimulation, updateSimulationState, updateSimulationMetadata, simulateGovernanceContractExecution } from './background.js'
import { getSettings, setUseTabsInsteadOfPopup, setMakeMeRich, setPage, setUseSignersAddressAsActiveAddress, updateActiveAddresses, updateContacts, updateWebsiteAccess, exportSettingsAndAddressBook, importSettingsAndAddressBook, getMakeMeRich, getUseTabsInsteadOfPopup, getMetamaskCompatibilityMode, setMetamaskCompatibilityMode } from './settings.js'
import { getPendingTransactions, getCurrentTabId, getOpenedAddressBookTabId, getTabState, saveCurrentTabId, setOpenedAddressBookTabId, setRpcList, getRpcList, getPrimaryRpcForChain, getSignerName, getRpcConnectionStatus, updateUserAddressBookEntries, getSimulationResults } from './storageVariables.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeMakeMeRich, ChangePage, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, InterceptorAccessRefresh, InterceptorAccessChangeAddress, Settings, RefreshConfirmTransactionMetadata, RefreshInterceptorAccessMetadata, ChangeSettings, ImportSettings, SetRpcList, IdentifyAddress, FindAddressBookEntryWithSymbolOrName, PersonalSignApproval, UpdateHomePage, RemoveSignedMessage, SimulateGovernanceContractExecutionReply, FetchAbiAndNameFromEtherscan } from '../types/interceptor-messages.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransaction, updateConfirmTransactionViewWithPendingTransactionOrClose } from './windows/confirmTransaction.js'
import { resolvePersonalSign } from './windows/personalSign.js'
import { getAddressMetadataForAccess, requestAddressChange, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { CHROME_NO_TAB_WITH_ID_ERROR } from '../utils/constants.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from './medataSearch.js'
import { getAddressBookEntriesForVisualiser, identifyAddress, nameTokenIds } from './metadataUtils.js'
import { assertUnreachable } from '../utils/typescript.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { refreshSimulationState, removeSignedMessageFromSimulation, removeTransactionAndUpdateTransactionNonces, resetSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { CompleteVisualizedSimulation, SimulationState } from '../types/visualizer-types.js'
import { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { isJSON } from '../utils/json.js'
import { UserAddressBook } from '../types/addressBookTypes.js'
import { serialize } from '../types/wire-types.js'
import { fetchAbiFromEtherscan } from '../simulation/services/EtherScanAbiFetcher.js'

export async function confirmDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	await resolvePendingTransaction(simulator, websiteTabConnections, confirmation)
}

export async function confirmPersonalSign(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: PersonalSignApproval) {
	await resolvePersonalSign(simulator, websiteTabConnections, confirmation)
}

export async function confirmRequestAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess(simulator, websiteTabConnections, confirmation.data)
}

export async function getLastKnownCurrentTabId() {
	const tabId = getCurrentTabId()
	const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true })
	if (tabs[0]?.id === undefined) {
		return await tabId
	}
	if (await tabId !== tabs[0].id) {
		saveCurrentTabId(tabs[0].id)
	}
	return tabs[0].id
}

export async function getSignerAccount() {
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
		const prependQueue = await getPrependTrasactions(ethereumClientService, settings, makeMeRichChange.data)
		return await resetSimulationState(ethereumClientService, { ...simulationState, prependTransactionsQueue: prependQueue })
	}, settings.activeSimulationAddress, true)
}

export async function removeAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	switch(removeAddressBookEntry.data.addressBookCategory) {
		case 'My Active Addresses': {
			await updateActiveAddresses((previousActiveAddresses) => previousActiveAddresses.filter((info) => info.address !== removeAddressBookEntry.data.address))
			updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'My Contacts': {
			await updateContacts((previousContacts) => previousContacts.filter((contact) => contact.address !== removeAddressBookEntry.data.address))
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'Non Fungible Tokens':
		case 'Other Contracts':
		case 'ERC1155 Tokens':
		case 'ERC20 Tokens': throw new Error('Tried to remove addressbook category that is not supported yet!')
		default: assertUnreachable(removeAddressBookEntry.data.addressBookCategory)
	}
}

export async function addOrModifyAddressBookEntry(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	const newEntry = entry.data
	switch (newEntry.type) {
		case 'activeAddress': {
			await updateActiveAddresses((previousActiveAddresses) => {
				if (previousActiveAddresses.find((x) => x.address === entry.data.address) ) {
					return previousActiveAddresses.map((x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousActiveAddresses.concat([newEntry])
				}
			})
			updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'ERC721':
		case 'ERC1155':
		case 'ERC20':
		case 'contract': {
			await updateUserAddressBookEntries((previousContacts) => {
				if (previousContacts.find((x) => x.address === entry.data.address) ) {
					return previousContacts.map((x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousContacts.concat([newEntry])
				}
			})
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'contact': {
			await updateContacts((previousContacts) => {
				if (previousContacts.find((x) => x.address === entry.data.address) ) {
					return previousContacts.map((x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousContacts.concat([newEntry])
				}
			})
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		default: assertUnreachable(newEntry)
	}
}

export async function changeInterceptorAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess(() => accessChange.data) // TODO: update 'popup_changeInterceptorAccess' to return list of changes instead of a new list
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export async function changePage(page: ChangePage) {
	await setPage(page.data)
}

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

export async function resetSimulation(simulator: Simulator, ethereumClientService: EthereumClientService, settings: Settings) {
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return undefined
		return await resetSimulationState(ethereumClientService, simulationState)
	}, settings.activeSimulationAddress, true)
}

export async function removeTransaction(simulator: Simulator, ethereumClientService: EthereumClientService, params: RemoveTransaction, settings: Settings) {
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return
		return await removeTransactionAndUpdateTransactionNonces(ethereumClientService, simulationState, params.data)
	}, settings.activeSimulationAddress, true)
}

export async function removeSignedMessage(simulator: Simulator, ethereumClientService: EthereumClientService, params: RemoveSignedMessage, settings: Settings) {
	await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return
		return await removeSignedMessageFromSimulation(ethereumClientService, simulationState, params.data)
	}, settings.activeSimulationAddress, true)
}

export async function refreshSimulation(simulator: Simulator, ethereumClientService: EthereumClientService, settings: Settings): Promise<SimulationState | undefined> {
	return await updateSimulationState(simulator.ethereum, async (simulationState) => {
		if (simulationState === undefined) return
		return await refreshSimulationState(ethereumClientService, simulationState)
	}, settings.activeSimulationAddress, false)
}

export async function refreshPopupConfirmTransactionMetadata(ethereumClientService: EthereumClientService, userAddressBook: UserAddressBook, { data }: RefreshConfirmTransactionMetadata) {
	const addressBookEntriesPromise = getAddressBookEntriesForVisualiser(ethereumClientService, data.visualizerResults, data.simulationState, userAddressBook)
	const namedTokenIdsPromise = nameTokenIds(ethereumClientService, data.visualizerResults)
	const promises = await getPendingTransactions()
	const first = promises[0]
	const addressBookEntries = await addressBookEntriesPromise
	const namedTokenIds = await namedTokenIdsPromise
	if (first === undefined || first.status !== 'Simulated' || first.simulationResults === undefined || first.simulationResults.statusCode !== 'success') return
	return await sendPopupMessageToOpenWindows({
		method: 'popup_update_confirm_transaction_dialog',
		data: [{
			...first,
			simulationResults: {
				statusCode: 'success',
				data: {
					...first.simulationResults.data,
					simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransaction(first.simulationResults.data.simulationState, first.simulationResults.data.visualizerResults, first.simulationResults.data.protectors, addressBookEntries, namedTokenIds),
					addressBookEntries: addressBookEntries,
				}
			}
		}, ...promises.slice(1)]
	})
}

export async function refreshPopupConfirmTransactionSimulation(simulator: Simulator, ethereumClientService: EthereumClientService) {
	const [firstTxn, ...remainingTxns] = await getPendingTransactions()
	if (firstTxn === undefined) return await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (firstTxn.status !== 'Simulated') return
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction' ? await formEthSendTransaction(ethereumClientService, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.transactionToSimulate.website, firstTxn.originalRequestParameters, firstTxn.created) : await formSendRawTransaction(ethereumClientService, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created)
	const refreshMessage = await refreshConfirmTransactionSimulation(simulator, ethereumClientService, firstTxn.activeAddress, firstTxn.simulationMode, firstTxn.uniqueRequestIdentifier, transactionToSimulate)
	if ('error' in transactionToSimulate) {
		return await sendPopupMessageToOpenWindows({
			method: 'popup_update_confirm_transaction_dialog',
			data: [{...firstTxn, transactionToSimulate, simulationResults: refreshMessage }, ...remainingTxns]
		})
	}
	return await sendPopupMessageToOpenWindows({
		method: 'popup_update_confirm_transaction_dialog',
		data: [ {...firstTxn, transactionToSimulate, simulationResults: refreshMessage }, ...remainingTxns]
	})
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
		const selectedNetworkToSwitch = settings.rpcNetwork.httpsRpc !== undefined ? settings.rpcNetwork : (await getRpcList())[0]
		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: params.data,
			...settings.rpcNetwork === selectedNetworkToSwitch ? {} : { rpcNetwork: selectedNetworkToSwitch }
		})
	}
}

export async function getAddressBookData(parsed: GetAddressBookData, userAddressBook: UserAddressBook | undefined) {
	if (userAddressBook === undefined) throw new Error('Interceptor is not ready')
	const data = await getMetadataForAddressBookData(parsed.data, userAddressBook)
	await sendPopupMessageToOpenWindows({
		method: 'popup_getAddressBookDataReply',
		data: {
			data: parsed.data,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

export async function openAddressBook() {
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: getHtmlFile('addressBook') })
		if (tab.id !== undefined) await setOpenedAddressBookTabId(tab.id)
	}

	const tabId = await getOpenedAddressBookTabId()
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	try {
		return await browser.tabs.update(addressBookTab.id, { active: true })
	} catch (error) {
		if (!(error instanceof Error)) throw error
		if (!error.message?.includes(CHROME_NO_TAB_WITH_ID_ERROR)) throw error
		// if tab is not found (user might have closed it)
		return await openInNewTab()
	}
}

export async function homeOpened(simulator: Simulator, refreshMetadata: boolean) {
	const settingsPromise = getSettings()
	const signerNamePromise = getSignerName()
	const makeMeRichPromise = getMakeMeRich()
	const rpcConnectionStatusPromise = getRpcConnectionStatus()
	const useTabsInsteadOfPopupPromise = getUseTabsInsteadOfPopup()
	const metamaskCompatibilityModePromise = getMetamaskCompatibilityMode()
	const rpcEntriesPromise = getRpcList()

	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = refreshMetadata ? updateSimulationMetadata(simulator.ethereum) : getSimulationResults()
	const tabId = await getLastKnownCurrentTabId()
	const tabState = tabId === undefined ? undefined : await getTabState(tabId)
	const signerName = await signerNamePromise
	const settings = await settingsPromise
	const makeMeRich = await makeMeRichPromise
	const rpcConnectionStatus = await rpcConnectionStatusPromise
	const useTabsInsteadOfPopup = await useTabsInsteadOfPopupPromise
	const metamaskCompatibilityMode = await metamaskCompatibilityModePromise
	const rpcEntries = await rpcEntriesPromise

	const updatedPage:UpdateHomePage = {
		method: 'popup_UpdateHomePage' as const,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			websiteAccessAddressMetadata: getAddressMetadataForAccess(settings.websiteAccess, settings.userAddressBook.activeAddresses),
			signerAccounts: tabState?.signerAccounts,
			signerChain: tabState?.signerChain,
			signerName: signerName,
			currentBlockNumber: simulator.ethereum.getLastKnownCachedBlockOrUndefined()?.number,
			settings: settings,
			tabIconDetails: tabState?.tabIconDetails,
			makeMeRich,
			rpcConnectionStatus,
			useTabsInsteadOfPopup,
			metamaskCompatibilityMode,
			rpcEntries,
			activeSigningAddressInThisTab: tabState?.activeSigningAddress,
			tabId,
		}
	}

	await sendPopupMessageToOpenWindows(serialize(UpdateHomePage, updatedPage))
}

export async function interceptorAccessChangeAddressOrRefresh(websiteTabConnections: WebsiteTabConnections, params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(websiteTabConnections, params)
}

export async function refreshInterceptorAccessMetadata(params: RefreshInterceptorAccessMetadata) {
	await refreshInterceptorAccessMetadata(params)
}

export async function changeSettings(simulator: Simulator, parsedRequest: ChangeSettings) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	return await homeOpened(simulator, true)
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
	const primary = await getPrimaryRpcForChain(settings.rpcNetwork.chainId)
	if (primary !== undefined) {
		// reset to primary on update
		simulator?.reset(primary)
	}
}

export async function popupIdentifyAddress(simulator: Simulator, parsedRequest: IdentifyAddress, settings: Settings) {
	const addressBookEntry = await identifyAddress(simulator.ethereum, settings.userAddressBook, parsedRequest.data.address)
	return await sendPopupMessageToOpenWindows({ method: 'popup_identifyAddressReply', data: { addressBookEntry } })
}

export async function popupFindAddressBookEntryWithSymbolOrName(parsedRequest: FindAddressBookEntryWithSymbolOrName, settings: Settings) {
	const addressBookEntryOrUndefined = await findEntryWithSymbolOrName(parsedRequest.data.symbol, parsedRequest.data.name, settings.userAddressBook)
	return await sendPopupMessageToOpenWindows({ method: 'popup_findAddressBookEntryWithSymbolOrNameReply', data: { 
		query: {
			symbol: parsedRequest.data.symbol,
			name: parsedRequest.data.name,
		},
		addressBookEntryOrUndefined,
	} })
}

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, userAddressBook: UserAddressBook) {
	const [firstTxn, ..._remainingTxns] = await getPendingTransactions()
	if (firstTxn === undefined) return                    
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(firstTxn, ethereum, userAddressBook)
	return await sendPopupMessageToOpenWindows(serialize(SimulateGovernanceContractExecutionReply, {
		method: 'popup_simulateGovernanceContractExecutionReply' as const,
		data: governanceContractExecutionVisualisation,
	}))
}

export async function fetchAbiAndNameFromEtherscan(parsedRequest: FetchAbiAndNameFromEtherscan) {
	const abi = await fetchAbiFromEtherscan(parsedRequest.data)
	return await sendPopupMessageToOpenWindows({
		method: 'popup_fetchAbiAndNameFromEtherscanReply' as const,
		data: abi,
	})
}


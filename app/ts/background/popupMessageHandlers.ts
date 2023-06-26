import { changeActiveAddressAndChainAndResetSimulation, changeActiveChain, getPrependTrasactions, refreshConfirmTransactionSimulation, resetSimulator, updateSimulationState } from './background.js'
import { getSettings, getMakeMeRich, getUseTabsInsteadOfPopup, setUseTabsInsteadOfPopup, setMakeMeRich, setPage, setUseSignersAddressAsActiveAddress, updateAddressInfos, updateContacts, updateWebsiteAccess, exportSettingsAndAddressBook, ExportedSettings, importSettingsAndAddressBook } from './settings.js'
import { getPendingTransactions, getCurrentTabId, getIsConnected, getOpenedAddressBookTabId, getSignerName, getSimulationResults, getTabState, saveCurrentTabId, setOpenedAddressBookTabId, setRPCList, getRPCList, getPrimaryRPCForChain } from './storageVariables.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeMakeMeRich, ChangePage, PersonalSign, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, RefreshConfirmTransactionDialogSimulation, UserAddressBook, InterceptorAccessRefresh, InterceptorAccessChangeAddress, Settings, RefreshConfirmTransactionMetadata, RefreshPersonalSignMetadata, RefreshInterceptorAccessMetadata, ChangeSettings, ImportSettings, SetRPCList } from '../utils/interceptor-messages.js'
import { resolvePendingTransaction } from './windows/confirmTransaction.js'
import { craftPersonalSignPopupMessage, resolvePersonalSign } from './windows/personalSign.js'
import { getAddressMetadataForAccess, requestAddressChange, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { CHROME_NO_TAB_WITH_ID_ERROR } from '../utils/constants.js'
import { getMetadataForAddressBookData } from './medataSearch.js'
import { getAddressBookEntriesForVisualiser } from './metadataUtils.js'
import { assertUnreachable } from '../utils/typescript.js'
import { WebsiteTabConnections } from '../utils/user-interface-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { refreshSimulationState, removeTransactionAndUpdateTransactionNonces, resetSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { isFailedToFetchError } from '../utils/errors.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { isJSON } from '../utils/wire-types.js'

export async function confirmDialog(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	await resolvePendingTransaction(ethereumClientService, websiteTabConnections, confirmation)
}

export async function confirmPersonalSign(websiteTabConnections: WebsiteTabConnections, confirmation: PersonalSign) {
	await resolvePersonalSign(websiteTabConnections, confirmation)
}

export async function confirmRequestAccess(websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess(websiteTabConnections, confirmation.data)
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

export async function changeActiveAddress(websiteTabConnections: WebsiteTabConnections, addressChange: ChangeActiveAddress) {

	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if (addressChange.data.activeAddress === 'signer') {
		const signerAccount = await getSignerAccount()
		await setUseSignersAddressAsActiveAddress(addressChange.data.activeAddress === 'signer', signerAccount)

		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] } )
		
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: signerAccount,
		})
	} else {
		await setUseSignersAddressAsActiveAddress(false)
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: addressChange.data.activeAddress,
		})
	}
}

export async function changeMakeMeRich(ethereumClientService: EthereumClientService, makeMeRichChange: ChangeMakeMeRich, settings: Settings) {
	await setMakeMeRich(makeMeRichChange.data)
	await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		const prependQueue = await getPrependTrasactions(ethereumClientService, settings, makeMeRichChange.data)
		return await resetSimulationState(ethereumClientService, { ...simulationState, prependTransactionsQueue: prependQueue })
	}, settings.activeSimulationAddress)
}

export async function removeAddressBookEntry(websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	switch(removeAddressBookEntry.data.addressBookCategory) {
		case 'My Active Addresses': {
			await updateAddressInfos((previousAddressInfos) => previousAddressInfos.filter((info) => info.address !== removeAddressBookEntry.data.address))
			updateWebsiteApprovalAccesses(websiteTabConnections, undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'My Contacts': {
			await updateContacts((previousContacts) => previousContacts.filter((contact) => contact.address !== removeAddressBookEntry.data.address))
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'Non Fungible Tokens':
		case 'Other Contracts':
		case 'Tokens': throw new Error('Tried to remove addressbook category that is not supported yet!')
		default: assertUnreachable(removeAddressBookEntry.data.addressBookCategory)
	}
}

export async function addOrModifyAddressInfo(websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	const newEntry = entry.data
	switch (newEntry.type) {
		case 'NFT':
		case 'other contract':
		case 'token': throw new Error(`No support to modify this entry yet! ${ newEntry.type }`)
		case 'addressInfo': {
			await updateAddressInfos((previousAddressInfos) => {
				if (previousAddressInfos.find((x) => x.address === entry.data.address) ) {
					return previousAddressInfos.map((x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousAddressInfos.concat([newEntry])
				}
			})
			updateWebsiteApprovalAccesses(websiteTabConnections, undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'contact': {
			await updateContacts((previousContacts) => {
				if (previousContacts.find( (x) => x.address === entry.data.address) ) {
					return previousContacts.map( (x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousContacts.concat([newEntry])
				}
			})
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		default: assertUnreachable(newEntry)
	}
}

export async function changeInterceptorAccess(websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess(() => accessChange.data) // TODO: update 'popup_changeInterceptorAccess' to return list of changes instead of a new list
	updateWebsiteApprovalAccesses(websiteTabConnections, undefined, await getSettings())
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

export async function resetSimulation(ethereumClientService: EthereumClientService, settings: Settings) {
	await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		return await resetSimulationState(ethereumClientService, simulationState)
	}, settings.activeSimulationAddress)
}

export async function removeTransaction(ethereumClientService: EthereumClientService, params: RemoveTransaction, settings: Settings) {
	await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return
		return await removeTransactionAndUpdateTransactionNonces(ethereumClientService, simulationState, params.data)
	}, settings.activeSimulationAddress)
}

export async function refreshSimulation(ethereumClientService: EthereumClientService, settings: Settings) {
	return await updateSimulationState(async() => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return
		return await refreshSimulationState(ethereumClientService, simulationState)
	}, settings.activeSimulationAddress)
}

export async function refreshPopupConfirmTransactionMetadata(ethereumClientService: EthereumClientService, userAddressBook: UserAddressBook, { data }: RefreshConfirmTransactionMetadata) {
	const addressBookEntries = await getAddressBookEntriesForVisualiser(ethereumClientService, data.visualizerResults.map((x) => x.visualizerResults), data.simulationState, userAddressBook)
	const promises = await getPendingTransactions()
	if (promises.length === 0) return
	const first = promises[0]
	if (first.simulationResults.statusCode !== 'success') return
	return await sendPopupMessageToOpenWindows({
		method: 'popup_update_confirm_transaction_dialog',
		data: [{
			statusCode: 'success',
			data: {
				...first.simulationResults.data,
				simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransaction(first.simulationResults.data.simulationState, first.simulationResults.data.visualizerResults, addressBookEntries),
				addressBookEntries,
			}
		}, ...promises.slice(1).map((p) => p.simulationResults)]
	})
}

export async function refreshPopupConfirmTransactionSimulation(ethereumClientService: EthereumClientService, { data }: RefreshConfirmTransactionDialogSimulation) {
	const refreshMessage = await refreshConfirmTransactionSimulation(ethereumClientService, data.activeAddress, data.simulationMode, data.requestId, data.transactionToSimulate, data.tabIdOpenedFrom)
	const promises = await getPendingTransactions()
	if (promises.length === 0) return
	const first = promises[0]
	if (first.simulationResults.data.requestId !== data.requestId) throw new Error('request id\'s do not match in refreshPopupConfirmTransactionSimulation')
	return await sendPopupMessageToOpenWindows({
		method: 'popup_update_confirm_transaction_dialog',
		data: [refreshMessage, ...promises.slice(1).map((p) => p.simulationResults)]
	})
}

export async function popupChangeActiveChain(websiteTabConnections: WebsiteTabConnections, params: ChangeActiveChain, settings: Settings) {
	return await changeActiveChain(websiteTabConnections, params.data, settings.simulationMode)
}

export async function changeChainDialog(websiteTabConnections: WebsiteTabConnections, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(websiteTabConnections, chainChange)
}

export async function enableSimulationMode(websiteTabConnections: WebsiteTabConnections, params: EnableSimulationMode) {
	const settings = await getSettings()
	// if we are on unsupported chain, force change to a supported one
	if (settings.useSignersAddressAsActiveAddress || params.data === false) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_eth_accounts', result: [] })
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
		const tabId = await getLastKnownCurrentTabId()
		const chainToSwitch = tabId === undefined ? undefined : (await getTabState(tabId)).signerChain
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: params.data,
			activeAddress: await getSignerAccount(),
			...chainToSwitch === undefined ? {} :  { activeChain: chainToSwitch },
		})
	} else {
		const chainToSwitch = await getPrimaryRPCForChain(settings.activeChain) ? settings.activeChain : 1n
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: params.data,
			...settings.activeChain === chainToSwitch ? {} : { activeChain: chainToSwitch }
		})
	}
}

export async function getAddressBookData(parsed: GetAddressBookData, userAddressBook: UserAddressBook | undefined) {
	if (userAddressBook === undefined) throw new Error('Interceptor is not ready')
	const data = getMetadataForAddressBookData(parsed.data, userAddressBook)
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

export async function homeOpened(simulator: Simulator) {
	const tabId = await getLastKnownCurrentTabId()
	const tabState = tabId === undefined ? undefined : await getTabState(tabId)

	const settings = await getSettings()
	let blockNumber = undefined
	try {
		blockNumber = await simulator.ethereum.getBlockNumber()
	} catch (error) {
		if (!(error instanceof Error)) throw error
		if (!isFailedToFetchError(error)) throw error
		await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block' })
	}
	const simResults = await getSimulationResults()
	const simulatedAndVisualizedTransactions = simResults.simulationState === undefined || simResults.visualizerResults === undefined ? [] : formSimulatedAndVisualizedTransaction(simResults.simulationState, simResults.visualizerResults, simResults.addressBookEntries)

	await sendPopupMessageToOpenWindows({
		method: 'popup_UpdateHomePage',
		data: {
			simulation: {
				...simResults,
				simulatedAndVisualizedTransactions: simulatedAndVisualizedTransactions,
			},
			websiteAccessAddressMetadata: getAddressMetadataForAccess(settings.websiteAccess, settings.userAddressBook.addressInfos),
			signerAccounts: tabState?.signerAccounts,
			signerChain: tabState?.signerChain,
			signerName: await getSignerName(),
			currentBlockNumber: blockNumber,
			settings: settings,
			tabIconDetails: tabState?.tabIconDetails,
			makeMeRich: await getMakeMeRich(),
			isConnected: await getIsConnected(),
			useTabsInsteadOfPopup: await getUseTabsInsteadOfPopup(),
			activeSigningAddressInThisTab: tabState?.activeSigningAddress,
			tabId,
			interceptorSupportForChainId: await getPrimaryRPCForChain(settings.activeChain) !== undefined,
		}
	})
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: await getRPCList() })
}

export async function interceptorAccessChangeAddressOrRefresh(websiteTabConnections: WebsiteTabConnections, params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(websiteTabConnections, params)
}

export async function refreshInterceptorAccessMetadata(params: RefreshInterceptorAccessMetadata) {
	await refreshInterceptorAccessMetadata(params)
}

export async function refreshPersonalSignMetadata(ethereumClientService: EthereumClientService, refreshPersonalSignMetadata: RefreshPersonalSignMetadata, settings: Settings) {
	return await sendPopupMessageToOpenWindows(await craftPersonalSignPopupMessage(
		ethereumClientService,
		refreshPersonalSignMetadata.data.originalParams,
		refreshPersonalSignMetadata.data.tabIdOpenedFrom,
		refreshPersonalSignMetadata.data.activeAddress.address,
		settings.userAddressBook,
		refreshPersonalSignMetadata.data.simulationMode,
		refreshPersonalSignMetadata.data.requestId,
		await getSignerName(),
		refreshPersonalSignMetadata.data.website,
	))
}

export async function changeSettings(simulator: Simulator, parsedRequest: ChangeSettings) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	return await homeOpened(simulator)
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
		data: { fileContents: JSON.stringify(ExportedSettings.serialize(exportedSettings), undefined, 4) }
	})
}

export async function setNewRPCList(request: SetRPCList, settings: Settings, simulator: Simulator) {
	await setRPCList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	const primary = await getPrimaryRPCForChain(settings.activeChain)
	if (primary !== undefined && primary.https_rpc !== simulator.ethereum.getRPCUrl()) {
		// reset simulator if the rpc url changed
		await resetSimulator(settings.activeChain)
	}
}

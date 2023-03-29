import { changeActiveAddressAndChainAndResetSimulation, changeActiveChain, refreshConfirmTransactionSimulation, updatePrependMode, updateSimulationState } from './background.js'
import { getMakeMeRich, getOpenedAddressBookTabId, getSettings, getSignerName, getSimulationResults, getTabState, setMakeMeRich, setOpenedAddressBookTabId, setPage, setSimulationMode, setUseSignersAddressAsActiveAddress, updateAddressInfos, updateContacts, updateWebsiteAccess } from './settings.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeMakeMeRich, ChangePage, PersonalSign, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ReviewNotification, RejectNotification, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, RefreshConfirmTransactionDialogSimulation, UserAddressBook, InterceptorAccessRefresh, InterceptorAccessChangeAddress, Settings } from '../utils/interceptor-messages.js'
import { resolvePendingTransaction } from './windows/confirmTransaction.js'
import { resolvePersonalSign } from './windows/personalSign.js'
import { changeAccess, getAddressMetadataForAccess, removePendingAccessRequestAndUpdateBadge, requestAccessFromUser, requestAddressChange, resolveExistingInterceptorAccessAsNoResponse, resolveInterceptorAccess } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { getAssociatedAddresses, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { isSupportedChain } from '../utils/constants.js'
import { getMetadataForAddressBookData } from './medataSearch.js'
import { findAddressInfo } from './metadataUtils.js'
import { assertUnreachable } from '../utils/typescript.js'
import { addressString } from '../utils/bigint.js'
import { AddressInfoEntry } from '../utils/user-interface-types.js'

export async function confirmDialog(_simulator: Simulator, confirmation: TransactionConfirmation) {
	await resolvePendingTransaction(confirmation.options.accept ? 'Approved' : 'Rejected')
}

export async function confirmPersonalSign(_simulator: Simulator, confirmation: PersonalSign) {
	await resolvePersonalSign(confirmation)
}

export async function confirmRequestAccess(_simulator: Simulator, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess(confirmation.options)
}

export async function getSignerAccount() {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true })//TODO, use stored tabid instead
	if (tabs.length === 0) return undefined
	const signerAccounts = tabs[0].id === undefined ? undefined : (await getTabState(tabs[0].id)).signerAccounts
	return signerAccounts !== undefined && signerAccounts.length > 0 ? signerAccounts[0] : undefined
}

export async function changeActiveAddress(_simulator: Simulator, addressChange: ChangeActiveAddress) {
	await setUseSignersAddressAsActiveAddress(addressChange.options === 'signer')

	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if (addressChange.options === 'signer') {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
		sendMessageToApprovedWebsitePorts('request_signer_chainId', [])
		await changeActiveAddressAndChainAndResetSimulation(await getSignerAccount(), 'noActiveChainChange', await getSettings())
	} else {
		await changeActiveAddressAndChainAndResetSimulation(addressChange.options, 'noActiveChainChange', await getSettings())
	}
}

export async function changeMakeMeRich(_simulator: Simulator, makeMeRichChange: ChangeMakeMeRich, settings: Settings) {
	await setMakeMeRich(makeMeRichChange.options)
	await updatePrependMode(settings)
}

export async function removeAddressBookEntry(_simulator: Simulator, removeAddressBookEntry: RemoveAddressBookEntry) {
	switch(removeAddressBookEntry.options.addressBookCategory) {
		case 'My Active Addresses': {
			await updateAddressInfos((previousAddressInfos) => previousAddressInfos.filter((info) => info.address !== removeAddressBookEntry.options.address))
			updateWebsiteApprovalAccesses(undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'My Contacts': {
			await updateContacts((previousContacts) => previousContacts.filter((contact) => contact.address !== removeAddressBookEntry.options.address))
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'Non Fungible Tokens':
		case 'Other Contracts':
		case 'Tokens': throw new Error('Tried to remove addressbook category that is not supported yet!')
		default: assertUnreachable(removeAddressBookEntry.options.addressBookCategory)
	}
}

export async function addOrModifyAddressInfo(_simulator: Simulator, entry: AddOrEditAddressBookEntry) {
	const newEntry = entry.options
	switch (newEntry.type) {
		case 'NFT':
		case 'other contract':
		case 'token': throw new Error(`No support to modify this entry yet! ${ newEntry.type }`)
		case 'addressInfo': {
			await updateAddressInfos((previousAddressInfos) => {
				if (previousAddressInfos.find((x) => x.address === entry.options.address) ) {
					return previousAddressInfos.map((x) => x.address === newEntry.address ? newEntry : x )
				} else {
					return previousAddressInfos.concat([newEntry])
				}
			})
			updateWebsiteApprovalAccesses(undefined, await getSettings())
			return await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
		case 'contact': {
			await updateContacts((previousContacts) => {
				if (previousContacts.find( (x) => x.address === entry.options.address) ) {
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

export async function changeInterceptorAccess(_simulator: Simulator, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess(() => accessChange.options) // TODO: update 'popup_changeInterceptorAccess' to return list of changes instead of a new list
	updateWebsiteApprovalAccesses(undefined, await getSettings())
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export async function changePage(_simulator: Simulator, page: ChangePage) {
	await setPage(page.options)
}

export async function requestAccountsFromSigner(_simulator: Simulator, params: RequestAccountsFromSigner) {
	if (params.options) {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
		sendMessageToApprovedWebsitePorts('request_signer_chainId', [])
	}
}

export async function resetSimulation(simulator: Simulator, settings: Settings) {
	await updateSimulationState(async () => await simulator.simulationModeNode.resetSimulation(), settings.activeSimulationAddress)
}

export async function removeTransaction(simulator: Simulator, params: RemoveTransaction, settings: Settings) {
	await updateSimulationState(async () => await simulator.simulationModeNode.removeTransactionAndUpdateTransactionNonces(params.options), settings.activeSimulationAddress)
}

export async function refreshSimulation(simulator: Simulator, settings: Settings) {
	await updateSimulationState(async() => await simulator.simulationModeNode.refreshSimulation(), settings.activeSimulationAddress)
}

export async function refreshPopupConfirmTransactionSimulation(_simulator: Simulator, { data }: RefreshConfirmTransactionDialogSimulation) {
	const refreshMessage = await refreshConfirmTransactionSimulation(data.activeAddress, data.simulationMode, data.requestId, data.transactionToSimulate, data.website, (await getSettings()).userAddressBook)
	if (refreshMessage === undefined) return
	return await sendPopupMessageToOpenWindows(refreshMessage)
}

export async function popupChangeActiveChain(_simulator: Simulator, params: ChangeActiveChain) {
	await changeActiveChain(params.options)
}

export async function changeChainDialog(_simulator: Simulator, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(chainChange)
}

export async function enableSimulationMode(_simulator: Simulator, params: EnableSimulationMode) {
	await setSimulationMode(params.options)
	const settings = await getSettings()
	// if we are on unsupported chain, force change to a supported one
	const chainToSwitch = isSupportedChain(settings.activeChain.toString()) ? settings.activeChain : 1n

	if (settings.useSignersAddressAsActiveAddress || params.options === false) {
		await changeActiveAddressAndChainAndResetSimulation(await getSignerAccount(), chainToSwitch, settings)
	} else {
		await changeActiveAddressAndChainAndResetSimulation(settings.simulationMode ? settings.activeSimulationAddress : settings.activeSigningAddress, chainToSwitch, settings)
	}

	if (!params.options || settings.useSignersAddressAsActiveAddress) {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
		sendMessageToApprovedWebsitePorts('request_signer_chainId', [])
	}
}

export async function reviewNotification(_simulator: Simulator, params: ReviewNotification, settings: Settings) {
	const notification = settings.pendingAccessRequests.find( (x) => x.website.websiteOrigin === params.options.website.websiteOrigin && x.requestAccessToAddress === params.options.requestAccessToAddress)
	if (notification === undefined) return
	await resolveExistingInterceptorAccessAsNoResponse()

	const addressInfo = notification.requestAccessToAddress === undefined ? undefined : findAddressInfo(BigInt(notification.requestAccessToAddress), settings.userAddressBook.addressInfos)
	const metadata = getAssociatedAddresses(settings, notification.website.websiteOrigin, addressInfo)
	await requestAccessFromUser(params.options.socket, notification.website, params.options.request, addressInfo, metadata, settings)
}
export async function rejectNotification(_simulator: Simulator, params: RejectNotification) {
	if (params.options.removeOnly) {
		await removePendingAccessRequestAndUpdateBadge(params.options.website.websiteOrigin, params.options.requestAccessToAddress)
	}

	await resolveInterceptorAccess({
		websiteOrigin : params.options.website.websiteOrigin,
		requestAccessToAddress: params.options.requestAccessToAddress,
		originalRequestAccessToAddress: params.options.requestAccessToAddress,
		approval: params.options.removeOnly ? 'NoResponse' : 'Rejected'
	}) // close pending access for this request if its open
	if (!params.options.removeOnly) {
		await changeAccess({
			websiteOrigin : params.options.website.websiteOrigin,
			requestAccessToAddress: params.options.requestAccessToAddress,
			originalRequestAccessToAddress: params.options.requestAccessToAddress,
			approval: 'Rejected'
		}, params.options.website )
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_notification_removed' })
}

export async function getAddressBookData(parsed: GetAddressBookData, userAddressBook: UserAddressBook | undefined) {
	if (userAddressBook === undefined) throw new Error('Interceptor is not ready')
	const data = getMetadataForAddressBookData(parsed.options, userAddressBook)
	await sendPopupMessageToOpenWindows({
		method: 'popup_getAddressBookDataReply',
		data: {
			options: parsed.options,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

export async function openAddressBook(_simulator: Simulator) {
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: getHtmlFile('addressBook') })
		if (tab.id !== undefined) await setOpenedAddressBookTabId(tab.id)
	}

	const tabId = await getOpenedAddressBookTabId()
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	return await browser.tabs.update(addressBookTab.id, { active: true })
}

export async function homeOpened(simulator: Simulator) {
	const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true }) //TODO, FIX: this gets wrong tab after its called after popup is opened
	const tabState = tabs[0]?.id === undefined ? undefined : await getTabState(tabs[0].id)

	const settings = await getSettings()
	const pendingAccessRequestsAddresses = new Set(settings.pendingAccessRequests.map((x) => x.requestAccessToAddress === undefined ? [] : x.requestAccessToAddress).flat())
	const addressInfos = settings.userAddressBook.addressInfos
	const pendingAccessMetadata: [string, AddressInfoEntry][] = Array.from(pendingAccessRequestsAddresses).map((x) => [addressString(x), findAddressInfo(BigInt(x), addressInfos)])

	await sendPopupMessageToOpenWindows({
		method: 'popup_UpdateHomePage',
		data: {
			simulation: await getSimulationResults(),
			websiteAccessAddressMetadata: getAddressMetadataForAccess(settings.websiteAccess, settings.userAddressBook.addressInfos),
			pendingAccessMetadata: pendingAccessMetadata,
			signerAccounts: tabState?.signerAccounts,
			signerChain: tabState?.signerChain,
			signerName: await getSignerName(),
			currentBlockNumber: await simulator.ethereum.getBlockNumber(),
			settings: settings,
			tabIconDetails: tabState?.tabIconDetails,
			makeMeRich: await getMakeMeRich()
		}
	})
}

export async function interceptorAccessChangeAddressOrRefresh(params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(params)
}

import { changeActiveAddressAndChainAndResetSimulation, changeActiveChain, PrependTransactionMode, refreshConfirmTransactionSimulation, updatePrependMode, updateSimulationState } from './background.js'
import { getOpenedAddressBookTabId, saveAddressInfos, saveContacts, saveMakeMeRich, saveOpenedAddressBookTabId, savePage, saveSimulationMode, saveUseSignersAddressAsActiveAddress, saveWebsiteAccess, UserAddressBook } from './settings.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeMakeMeRich, ChangePage, PersonalSign, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ReviewNotification, RejectNotification, ChangeActiveChain, AddOrEditAddressBookEntry, GetAddressBookData, RemoveAddressBookEntry, RefreshConfirmTransactionDialogSimulation } from '../utils/interceptor-messages.js'
import { resolvePendingTransaction } from './windows/confirmTransaction.js'
import { resolvePersonalSign } from './windows/personalSign.js'
import { changeAccess, requestAccessFromUser, resolveExistingInterceptorAccessAsNoResponse, resolveInterceptorAccess, setPendingAccessRequests } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { getAssociatedAddresses, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { isSupportedChain } from '../utils/constants.js'
import { getMetadataForAddressBookData } from './medataSearch.js'
import { findAddressInfo } from './metadataUtils.js'
import { assertUnreachable } from '../utils/typescript.js'

export async function confirmDialog(_simulator: Simulator, confirmation: TransactionConfirmation) {
	await resolvePendingTransaction(confirmation.options.accept ? 'Approved' : 'Rejected')
}

export async function confirmPersonalSign(_simulator: Simulator, confirmation: PersonalSign) {
	await resolvePersonalSign(confirmation)
}

export async function confirmRequestAccess(_simulator: Simulator, confirmation: InterceptorAccess) {
	await resolveInterceptorAccess({
		outcome: confirmation.options.accept ? 'Approved' : 'Rejected',
		origin: confirmation.options.origin,
		requestAccessToAddress: confirmation.options.requestAccessToAddress,
	})
}

export async function changeActiveAddress(_simulator: Simulator, addressChange: ChangeActiveAddress) {
	if (window.interceptor.settings === undefined) return
	window.interceptor.settings.useSignersAddressAsActiveAddress = addressChange.options === 'signer'

	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if(addressChange.options === 'signer') {
		await changeActiveAddressAndChainAndResetSimulation(window.interceptor.signerAccounts && window.interceptor.signerAccounts.length > 0 ? window.interceptor.signerAccounts[0] : undefined, 'noActiveChainChange')
	} else {
		await changeActiveAddressAndChainAndResetSimulation(addressChange.options, 'noActiveChainChange')
	}

	saveUseSignersAddressAsActiveAddress(window.interceptor.settings.useSignersAddressAsActiveAddress)
}

export async function changeMakeMeRich(_simulator: Simulator, makeMeRichChange: ChangeMakeMeRich) {
	if (window.interceptor.settings === undefined) return

	if (makeMeRichChange.options) {
		window.interceptor.prependTransactionMode = PrependTransactionMode.RICH_MODE
	} else {
		window.interceptor.prependTransactionMode = PrependTransactionMode.NO_PREPEND
	}
	window.interceptor.settings.makeMeRich = makeMeRichChange.options

	saveMakeMeRich(makeMeRichChange.options)
	await updatePrependMode(true)
}

export async function removeAddressBookEntry(_simulator: Simulator, removeAddressBookEntry: RemoveAddressBookEntry) {
	if (window.interceptor.settings === undefined) return
	switch(removeAddressBookEntry.options.addressBookCategory) {
		case 'My Active Addresses': {
			window.interceptor.settings.userAddressBook.addressInfos = window.interceptor.settings.userAddressBook.addressInfos.filter((info) => info.address !== removeAddressBookEntry.options.address)
			saveAddressInfos(window.interceptor.settings.userAddressBook.addressInfos)
			updateWebsiteApprovalAccesses()
			sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return
		}
		case 'My Contacts': {
			window.interceptor.settings.userAddressBook.contacts = window.interceptor.settings.userAddressBook.contacts.filter((contact) => contact.address !== removeAddressBookEntry.options.address)
			saveContacts(window.interceptor.settings.userAddressBook.contacts)
			sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return
		}
		case 'Non Fungible Tokens':
		case 'Other Contracts':
		case 'Tokens': throw new Error('Tried to remove addressbook category that is not supported yet!')
		default: assertUnreachable(removeAddressBookEntry.options.addressBookCategory)
	}
}

export async function addOrModifyAddressInfo(_simulator: Simulator, entry: AddOrEditAddressBookEntry) {
	if (window.interceptor.settings === undefined) return
	const newEntry = entry.options
	switch (newEntry.type) {
		case 'NFT':
		case 'other contract':
		case 'token': throw new Error(`No support to modify this entry yet! ${ newEntry.type }`)
		case 'addressInfo': {
			if (window.interceptor.settings.userAddressBook.addressInfos.find( (x) => x.address === entry.options.address) ) {
				window.interceptor.settings.userAddressBook.addressInfos = window.interceptor.settings.userAddressBook.addressInfos.map( (x) => x.address === newEntry.address ? newEntry : x )
			} else {
				window.interceptor.settings.userAddressBook.addressInfos = window.interceptor.settings.userAddressBook.addressInfos.concat([newEntry])
			}
			saveAddressInfos(window.interceptor.settings.userAddressBook.addressInfos)
			updateWebsiteApprovalAccesses()
			sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return
		}
		case 'contact': {
			if (window.interceptor.settings.userAddressBook.contacts.find( (x) => x.address === entry.options.address) ) {
				window.interceptor.settings.userAddressBook.contacts = window.interceptor.settings.userAddressBook.contacts.map( (x) => x.address === newEntry.address ? newEntry : x )
			} else {
				window.interceptor.settings.userAddressBook.contacts = window.interceptor.settings.userAddressBook.contacts.concat([newEntry])
			}
			saveContacts(window.interceptor.settings.userAddressBook.contacts)
			sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
			return
		}
		default: assertUnreachable(newEntry)
	}
}

export async function changeInterceptorAccess(_simulator: Simulator, accessChange: ChangeInterceptorAccess) {
	if (window.interceptor.settings === undefined) return
	window.interceptor.settings.websiteAccess = accessChange.options
	saveWebsiteAccess(accessChange.options)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export async function changePage(_simulator: Simulator, page: ChangePage) {
	if (window.interceptor.settings === undefined) return
	window.interceptor.settings.page = page.options
	savePage(page.options)
}

export async function requestAccountsFromSigner(_simulator: Simulator, params: RequestAccountsFromSigner) {
	if (params.options) {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
	}
}

export async function resetSimulation(simulator: Simulator) {
	await updateSimulationState(async () => await simulator.simulationModeNode.resetSimulation())
}

export async function removeTransaction(simulator: Simulator, params: RemoveTransaction) {
	await updateSimulationState(async () => await simulator.simulationModeNode.removeTransactionAndUpdateTransactionNonces(params.options))
}

export async function refreshSimulation(simulator: Simulator) {
	await updateSimulationState(async() => await simulator.simulationModeNode.refreshSimulation())
}

export async function refreshPopupConfirmTransactionSimulation(_simulator: Simulator, { data }: RefreshConfirmTransactionDialogSimulation) {
	const refreshMessage = await refreshConfirmTransactionSimulation(data.activeAddress, data.simulationMode, data.requestId, data.transactionToSimulate, data.websiteOrigin, data.websiteIcon)
	if (refreshMessage === undefined) return
	return sendPopupMessageToOpenWindows(refreshMessage)
}

export async function popupChangeActiveChain(_simulator: Simulator, params: ChangeActiveChain) {
	await changeActiveChain(params.options)
}

export async function changeChainDialog(_simulator: Simulator, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(chainChange)
}

export async function enableSimulationMode(_simulator: Simulator, params: EnableSimulationMode) {
	if (window.interceptor.settings === undefined) return

	window.interceptor.settings.simulationMode = params.options
	saveSimulationMode(params.options)
	// if we are on unsupported chain, force change to a supported one
	const chainToSwitch = isSupportedChain(window.interceptor.settings.activeChain.toString()) ? window.interceptor.settings.activeChain : 1n

	if(window.interceptor.settings.useSignersAddressAsActiveAddress || window.interceptor.settings.simulationMode === false) {
		await changeActiveAddressAndChainAndResetSimulation(window.interceptor.signerAccounts && window.interceptor.signerAccounts.length > 0 ? window.interceptor.signerAccounts[0] : undefined, chainToSwitch)
	} else {
		await changeActiveAddressAndChainAndResetSimulation(window.interceptor.settings.simulationMode ? window.interceptor.settings.activeSimulationAddress : window.interceptor.settings.activeSigningAddress, chainToSwitch)
	}

	if (!params.options) {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
		sendMessageToApprovedWebsitePorts('request_signer_chainId', EthereumQuantity.serialize(window.interceptor.settings.activeChain))
	}
}

export async function reviewNotification(_simulator: Simulator, params: ReviewNotification) {
	if (window.interceptor.settings === undefined) return
	const notification = window.interceptor.settings.pendingAccessRequests.find( (x) => x.origin === params.options.origin && x.requestAccessToAddress === params.options.requestAccessToAddress)
	if (notification === undefined) return
	await resolveExistingInterceptorAccessAsNoResponse()

	const addressInfo = notification.requestAccessToAddress === undefined ? undefined : findAddressInfo(BigInt(notification.requestAccessToAddress), window.interceptor.settings.userAddressBook.addressInfos)
	const metadata = getAssociatedAddresses(window.interceptor.settings, notification.origin, addressInfo)
	await requestAccessFromUser(notification.origin, notification.icon, addressInfo, metadata)
}
export async function rejectNotification(_simulator: Simulator, params: RejectNotification) {
	if (window.interceptor.settings === undefined) return
	const notification = window.interceptor.settings.pendingAccessRequests.find( (x) => x.origin === params.options.origin && x.requestAccessToAddress === params.options.requestAccessToAddress)

	if (params.options.removeOnly) {
		await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.filter( (x) => !(x.origin === params.options.origin && x.requestAccessToAddress === params.options.requestAccessToAddress) ) )
	}

	await resolveInterceptorAccess({
		origin : params.options.origin,
		requestAccessToAddress: params.options.requestAccessToAddress,
		outcome: params.options.removeOnly ? 'NoResponse' : 'Rejected'
	}) // close pending access for this request if its open
	if (!params.options.removeOnly) {
		await changeAccess(
			{
				origin : params.options.origin,
				requestAccessToAddress: params.options.requestAccessToAddress,
				outcome: 'Rejected'
			},
			params.options.origin,
			notification?.icon,
			params.options.requestAccessToAddress,
		)
	}
	sendPopupMessageToOpenWindows({ method: 'popup_notification_removed' })
}

export async function getAddressBookData(parsed: GetAddressBookData, userAddressBook: UserAddressBook | undefined) {
	if (userAddressBook === undefined) throw new Error('Interceptor is not ready')
	const data = getMetadataForAddressBookData(parsed.options, userAddressBook)
	sendPopupMessageToOpenWindows({
		method: 'popup_getAddressBookData',
		data: {
			options: parsed.options,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

export async function openAddressBook(_simulator: Simulator) {
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: '/html/addressBook.html' })
		if (tab.id !== undefined) saveOpenedAddressBookTabId(tab.id)
	}

	const tabId = await getOpenedAddressBookTabId()
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	return await browser.tabs.update(addressBookTab.id, { active: true })
}

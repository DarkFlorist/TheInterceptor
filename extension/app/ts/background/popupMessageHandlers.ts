import { changeActiveAddressAndChainAndResetSimulation, changeActiveChain, PrependTransactionMode, refreshConfirmTransactionSimulation, updatePrependMode, updateSimulationState } from './background.js'
import { getOpenedAddressBookTabId, saveAddressInfos, saveMakeMeRich, saveOpenedAddressBookTabId, savePage, saveSimulationMode, saveUseSignersAddressAsActiveAddress, saveWebsiteAccess } from './settings.js'
import { Simulator } from '../simulation/simulator.js'
import { ChangeActiveAddress, ChangeAddressInfos, ChangeMakeMeRich, ChangePage, PersonalSign, PopupMessage, RemoveTransaction, RequestAccountsFromSigner, TransactionConfirmation, InterceptorAccess, ChangeInterceptorAccess, ChainChangeConfirmation, EnableSimulationMode, ReviewNotification, RejectNotification, ChangeActiveChain, AddOrModifyAddresInfo, GetAddressBookData, RemoveAddressBookEntry } from '../utils/interceptor-messages.js'
import { resolvePendingTransaction } from './windows/confirmTransaction.js'
import { resolvePersonalSign } from './windows/personalSign.js'
import { changeAccess, requestAccessFromUser, resolveExistingInterceptorAccessAsNoResponse, resolveInterceptorAccess, setPendingAccessRequests } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { getAssociatedAddresses, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { isSupportedChain } from '../utils/constants.js'
import { getMetadataForAddressBookData } from './medataSearch.js'
import { addressString } from '../utils/bigint.js'
import { findAddressInfo } from './metadataUtils.js'

export async function confirmDialog(_simulator: Simulator, payload: PopupMessage) {
	const confirmation = TransactionConfirmation.parse(payload)
	await resolvePendingTransaction(confirmation.options.accept ? 'Approved' : 'Rejected')
}

export async function confirmPersonalSign(_simulator: Simulator, payload: PopupMessage) {
	const confirmation = PersonalSign.parse(payload)
	await resolvePersonalSign(confirmation)
}

export async function confirmRequestAccess(_simulator: Simulator, payload: PopupMessage) {
	const confirmation = InterceptorAccess.parse(payload)
	await resolveInterceptorAccess({
		outcome: confirmation.options.accept ? 'Approved' : 'Rejected',
		origin: confirmation.options.origin,
        requestAccessToAddress: confirmation.options.requestAccessToAddress === undefined ? undefined : addressString(confirmation.options.requestAccessToAddress),
	})
}

export async function changeActiveAddress(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const addressChange = ChangeActiveAddress.parse(payload)
	window.interceptor.settings.useSignersAddressAsActiveAddress = addressChange.options === 'signer'

	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if(addressChange.options === 'signer') {
		await changeActiveAddressAndChainAndResetSimulation(window.interceptor.signerAccounts && window.interceptor.signerAccounts.length > 0 ? window.interceptor.signerAccounts[0] : undefined, 'noActiveChainChange')
	} else {
		await changeActiveAddressAndChainAndResetSimulation(addressChange.options, 'noActiveChainChange')
	}

	saveUseSignersAddressAsActiveAddress(window.interceptor.settings.useSignersAddressAsActiveAddress)
}

export async function changeMakeMeRich(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const makeMeRichChange = ChangeMakeMeRich.parse(payload)

	if (makeMeRichChange.options) {
		window.interceptor.prependTransactionMode = PrependTransactionMode.RICH_MODE
	} else {
		window.interceptor.prependTransactionMode = PrependTransactionMode.NO_PREPEND
	}
	window.interceptor.settings.makeMeRich = makeMeRichChange.options

	saveMakeMeRich(makeMeRichChange.options)
	await updatePrependMode(true)
}

export async function changeAddressInfos(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const addressInfosChange = ChangeAddressInfos.parse(payload)
	window.interceptor.settings.addressInfos = addressInfosChange.options
	saveAddressInfos(addressInfosChange.options)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ message: 'popup_address_infos_changed' })
}

export async function removeAddressBookEntry(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const removeAddressBookEntry = RemoveAddressBookEntry.parse(payload)
	if (removeAddressBookEntry.options.addressBookCategory === 'My Active Addresses') {
		window.interceptor.settings.addressInfos = window.interceptor.settings.addressInfos.filter((info) => info.address !== removeAddressBookEntry.options.address)
		saveAddressInfos(window.interceptor.settings.addressInfos)
		updateWebsiteApprovalAccesses()
		sendPopupMessageToOpenWindows({ message: 'popup_address_infos_changed' })
		return
	}
	throw new Error('Tried to remove addressbook category that is not supported yet!')
}

export async function addOrModifyAddressInfo(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const addressInfosChanges = AddOrModifyAddresInfo.parse(payload)
	for (const newEntry of addressInfosChanges.options) {
		if (newEntry.type !== 'addressInfo') throw new Error('No support to modify this entry yet!')
		if (window.interceptor.settings.addressInfos.find( (x) => x.address === newEntry.address) ) {
			// replace in place to maintain the same order
			window.interceptor.settings.addressInfos = window.interceptor.settings.addressInfos.map( (x) => x.address === newEntry.address ? newEntry : x )
		} else {
			// append to the end
			window.interceptor.settings.addressInfos = window.interceptor.settings.addressInfos.concat([newEntry])
		}
	}

	saveAddressInfos(window.interceptor.settings.addressInfos)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ message: 'popup_address_infos_changed' })
}

export async function changeInterceptorAccess(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const accessChange = ChangeInterceptorAccess.parse(payload)
	window.interceptor.settings.websiteAccess = accessChange.options
	saveWebsiteAccess(accessChange.options)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ message: 'popup_interceptor_access_changed' })
}

export async function changePage(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const page = ChangePage.parse(payload)
	window.interceptor.settings.page = page.options
	savePage(page.options)
}

export async function requestAccountsFromSigner(_simulator: Simulator, payload: PopupMessage) {
	const params = RequestAccountsFromSigner.parse(payload)
	if (params.options) {
		sendMessageToApprovedWebsitePorts('request_signer_to_eth_requestAccounts', [])
	}
}

export async function resetSimulation(simulator: Simulator, _payload: PopupMessage) {
	await updateSimulationState(async () => await simulator.simulationModeNode.resetSimulation())
}

export async function removeTransaction(simulator: Simulator, payload: PopupMessage) {
	const params = RemoveTransaction.parse(payload)
	await updateSimulationState(async () => await simulator.simulationModeNode.removeTransactionAndUpdateTransactionNonces(params.options))
}

export async function RefreshSimulation(simulator: Simulator, _payload: PopupMessage) {
	await updateSimulationState(async() => await simulator.simulationModeNode.refreshSimulation())
}

export async function refreshPopupConfirmTransactionSimulation(_simulator: Simulator, _payload: PopupMessage) {
	await refreshConfirmTransactionSimulation()
}

export async function popupChangeActiveChain(_simulator: Simulator, payload: PopupMessage) {
	const params = ChangeActiveChain.parse(payload)
	await changeActiveChain(params.options)
}

export async function changeChainDialog(_simulator: Simulator, payload: PopupMessage) {
	const chainChange = ChainChangeConfirmation.parse(payload)
	await resolveChainChange(chainChange)
}

export async function enableSimulationMode(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const params = EnableSimulationMode.parse(payload)

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

export async function reviewNotification(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const params = ReviewNotification.parse(payload)
	const notification = window.interceptor.settings.pendingAccessRequests.find( (x) => x.origin === params.options.origin && x.requestAccessToAddress === params.options.requestAccessToAddress)
	if (notification === undefined) return
	await resolveExistingInterceptorAccessAsNoResponse()

	const addressInfo = notification.requestAccessToAddress === undefined ? undefined : findAddressInfo(BigInt(notification.requestAccessToAddress), window.interceptor.settings.addressInfos)
	const metadata = getAssociatedAddresses(window.interceptor.settings, notification.origin, addressInfo)
	await requestAccessFromUser(notification.origin, notification.icon, addressInfo, metadata)
}
export async function rejectNotification(_simulator: Simulator, payload: PopupMessage) {
	if (window.interceptor.settings === undefined) return
	const params = RejectNotification.parse(payload)
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
			params.options.requestAccessToAddress
		)
	}
	sendPopupMessageToOpenWindows({ message: 'popup_notification_removed' })
}

export async function getAddressBookData(_simulator: Simulator, payload: PopupMessage) {
	const parsed = GetAddressBookData.parse(payload)
	const data = getMetadataForAddressBookData(parsed.options, window.interceptor.settings?.addressInfos)
	sendPopupMessageToOpenWindows({
		message: 'popup_getAddressBookData',
		data: {
			options: parsed.options,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

export async function openAddressBook(_simulator: Simulator, _payload: PopupMessage) {
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

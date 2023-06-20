import { PopupOrTab, addWindowTabListener, closePopupOrTab, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListener } from '../../components/ui-utils.js'
import { METAMASK_ERROR_ALREADY_PENDING } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ExternalPopupMessage, InterceptedRequest, InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, PendingAccessRequestArray, Settings, WebsiteAccessArray, WindowMessage } from '../../utils/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { AddressInfo, AddressInfoEntry, Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, handleContentScriptMessage, postMessageIfStillConnected, refuseAccess } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { findAddressInfo } from '../metadataUtils.js'
import { getSettings } from '../settings.js'
import { getSignerName, getTabState, updatePendingAccessRequests, getPendingAccessRequests, clearPendingAccessRequests } from '../storageVariables.js'

type OpenedDialogWithListeners = {
	popupOrTab: PopupOrTab
	onCloseWindow: (windowId: number) => void
	windowReadyAndListening: (msg: unknown) => Promise<void>
} | undefined

let openedDialog: OpenedDialogWithListeners = undefined

const pendingInterceptorAccessSemaphore = new Semaphore(1)

const onCloseWindow = async (windowId: number, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject signature
	if (openedDialog?.popupOrTab.windowOrTab.id !== windowId) return
	browser.runtime.onMessage.removeListener(openedDialog.windowReadyAndListening)
	removeWindowTabListener(openedDialog.onCloseWindow)

	openedDialog = undefined
	const pendingRequests = await clearPendingAccessRequests()
	for (const pendingRequest of pendingRequests) {
		const reply = {
			originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
			requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
			accessRequestId: pendingRequest.accessRequestId,
			userReply: 'NoResponse' as const
		}
		await resolve(websiteTabConnections, reply, pendingRequest.socket, pendingRequest.request, pendingRequest.website, pendingRequest.activeAddress)
	}
}

export async function resolveInterceptorAccess(websiteTabConnections: WebsiteTabConnections, reply: InterceptorAccessReply) {
	const promises = await getPendingAccessRequests()
	const pendingRequest = promises.find((req) => req.accessRequestId === reply.accessRequestId)
	if (pendingRequest == undefined) return
	return await resolve(websiteTabConnections, reply, pendingRequest.socket, pendingRequest.request, pendingRequest.website, pendingRequest.activeAddress)
}

export function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray, addressInfos: readonly AddressInfo[]): AddressInfoEntry[] {
	const addresses = websiteAccess.map((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address)).flat()
	const addressSet = new Set(addresses)
	return Array.from(addressSet).map((x) => findAddressInfo(x, addressInfos))
}

export async function changeAccess(websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply, website: Website, promptForAccessesIfNeeded: boolean = true) {
	if (confirmation.userReply === 'NoResponse') return
	await setAccess(website, confirmation.userReply === 'Approved', confirmation.requestAccessToAddress)
	updateWebsiteApprovalAccesses(websiteTabConnections, promptForAccessesIfNeeded, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

async function askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const tabState = await getTabState(socket.tabId)
	if (tabState.signerAccounts.length !== 0) return tabState.signerAccounts

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && websiteSocketToString(message.data.socket) === websiteSocketToString(socket)) return future.resolve()
	})
	const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	try {
		channel.addEventListener('message', listener)
		const messageSent = postMessageIfStillConnected(websiteTabConnections, socket, { method: 'request_signer_to_eth_requestAccounts' })
		if (messageSent) await future
	} finally {
		channel.removeEventListener('message', listener)
		channel.close()
	}
	return (await getTabState(socket.tabId)).signerAccounts
}

export async function requestAccessFromUser(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest | undefined,
	requestAccessToAddress: AddressInfoEntry | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
) {
	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && settings.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address)?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined
	const closeWindowCallback = (windowId: number) => onCloseWindow(windowId, websiteTabConnections) 

	const pendingAccessRequests = new Future<PendingAccessRequestArray>()

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_interceptorAccessReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: await pendingAccessRequests })
		return
	}

	await pendingInterceptorAccessSemaphore.execute(async () => {
		const verifyPendingRequests = async () => {
			const previousRequests = await getPendingAccessRequests()
			if (previousRequests.length !== 0) {
				if (await getPopupOrTabOnlyById(previousRequests[0].dialogId) !== undefined) {
					return true
				} else {
					await clearPendingAccessRequests()
				}
			}
			return false
		}

		const justAddToPending = await verifyPendingRequests()

		if (!justAddToPending) {
			browser.runtime.onMessage.addListener(windowReadyAndListening)
			addWindowTabListener(closeWindowCallback)
			const popupOrTab = await openPopupOrTab({
				url: getHtmlFile('interceptorAccess'),
				type: 'popup',
				height: 800,
				width: 600,
			})
			if (popupOrTab?.windowOrTab.id === undefined) {
				if (request !== undefined) refuseAccess(websiteTabConnections, socket, request)
				throw new Error('Opened dialog does not exist')
			}
			if (openedDialog) {
				browser.runtime.onMessage.removeListener(openedDialog.windowReadyAndListening)
				removeWindowTabListener(openedDialog.onCloseWindow)
				await closePopupOrTab(openedDialog.popupOrTab)
			}
			openedDialog = { popupOrTab, onCloseWindow: closeWindowCallback, windowReadyAndListening, }
		}

		if (openedDialog?.popupOrTab.windowOrTab.id === undefined) {
			if (request !== undefined) refuseAccess(websiteTabConnections, socket, request)
			throw new Error('Opened dialog does not exist')
		}
		const accessRequestId =  `${ accessAddress } || ${ website.websiteOrigin }`
		const pendingRequest = {
			dialogId: openedDialog.popupOrTab.windowOrTab.id,
			socket,
			request,
			accessRequestId,
			website,
			requestAccessToAddress: accessAddress,
			originalRequestAccessToAddress: accessAddress,
			associatedAddresses: requestAccessToAddress !== undefined ? getAssociatedAddresses(settings, website.websiteOrigin, requestAccessToAddress) : [],
			addressInfos: settings.userAddressBook.addressInfos,
			signerAccounts: [],
			signerName: await getSignerName(),
			simulationMode: settings.simulationMode,
			activeAddress: activeAddress,
		}

		const requests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
			if (previousPendingAccessRequests.find((x) => x.accessRequestId === accessRequestId) === undefined) {
				return previousPendingAccessRequests.concat(pendingRequest)
			}
			return previousPendingAccessRequests
		})

		if (requests.find((x) => x.accessRequestId === accessRequestId) === undefined) {
			if (request !== undefined) {
				postMessageIfStillConnected(websiteTabConnections, socket, {
					requestId: request.requestId,
					options: request.options,
					error: METAMASK_ERROR_ALREADY_PENDING.error,
				})
			}
			return
		}
		if (justAddToPending) {
			if (requests.findIndex((x) => x.accessRequestId === accessRequestId) === 0) {
				await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: requests })
			}
			return await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_dialog_pending_changed', data: requests })
		}
		pendingAccessRequests.resolve(requests)
	})
}

async function updateViewOrClose() {
	const promises = await getPendingAccessRequests()
	if (promises.length > 0) return sendPopupMessageToOpenWindows({ method: 'popup_update_access_dialog', data: promises })
	if (openedDialog) {
		browser.runtime.onMessage.removeListener(openedDialog.windowReadyAndListening)
		removeWindowTabListener(openedDialog.onCloseWindow)
		await closePopupOrTab(openedDialog.popupOrTab)
		openedDialog = undefined
	}
}

async function resolve(websiteTabConnections: WebsiteTabConnections, accessReply: InterceptorAccessReply, socket: WebsiteSocket, request: InterceptedRequest | undefined, website: Website, activeAddress: bigint | undefined) {
	await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
		return previousPendingAccessRequests.filter((x) => !(x.website.websiteOrigin === website.websiteOrigin && (x.requestAccessToAddress?.address === accessReply.requestAccessToAddress || x.requestAccessToAddress?.address === accessReply.originalRequestAccessToAddress)))
	})
	if (accessReply.userReply === 'NoResponse') {
		if (request !== undefined) refuseAccess(websiteTabConnections, socket, request)
	} else {
		const userRequestedAddressChange = accessReply.requestAccessToAddress !== accessReply.originalRequestAccessToAddress
		if (!userRequestedAddressChange) {
			await changeAccess(websiteTabConnections, accessReply, website)
		} else {
			if (accessReply.requestAccessToAddress === undefined) throw new Error('Changed request to page level')
			await changeAccess(websiteTabConnections, accessReply, website, false)
			const settings = await getSettings()
			await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
				simulationMode: settings.simulationMode,
				activeAddress: accessReply.requestAccessToAddress,
			})
		}
		if (request !== undefined) await handleContentScriptMessage(websiteTabConnections, socket, request, website, activeAddress)
	}
	await updateViewOrClose()
}

export async function requestAddressChange(websiteTabConnections: WebsiteTabConnections, message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	const newRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
		if (message.options.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
		async function getProposedAddress() {
			if (message.method === 'popup_interceptorAccessRefresh' || message.options.newActiveAddress === 'signer') {
				const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, message.options.socket)
				return signerAccounts === undefined || signerAccounts.length == 0 ? undefined : signerAccounts[0]
			}
			return message.options.newActiveAddress
		}

		const proposedAddress = await getProposedAddress()
		const settings = await getSettings()
		const newActiveAddress = proposedAddress === undefined ? message.options.requestAccessToAddress : proposedAddress
		const newActiveAddressAddressInfo = findAddressInfo(newActiveAddress, settings.userAddressBook.addressInfos)
		const associatedAddresses = getAssociatedAddresses(settings, message.options.website.websiteOrigin, newActiveAddressAddressInfo)
		
		return previousPendingAccessRequests.map((request) => {
			if (request.accessRequestId === message.options.accessRequestId) {
				return {
					...request,
					associatedAddresses,
					requestAccessTo: newActiveAddress
				}
			}
			return request
		})
	})
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: newRequests,
	})
}

export async function interceptorAccessMetadataRefresh() {
	const settings = await getSettings()
	const signerName = await getSignerName()
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: (await getPendingAccessRequests()).map((request) => {
			const requestAccessTo = request.requestAccessToAddress === undefined ? undefined : findAddressInfo(request.requestAccessToAddress?.address, settings.userAddressBook.addressInfos)
			const associatedAddresses = getAssociatedAddresses(settings, request.website.websiteOrigin, requestAccessTo)
			return {
				...request,
				associatedAddresses,
				signerName: signerName,
				requestAccessTo
			}
		})
	})
}

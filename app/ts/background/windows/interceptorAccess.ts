import { PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListeners, tryFocusingTabOrWindow } from '../../components/ui-utils.js'
import { METAMASK_ERROR_ALREADY_PENDING } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, Settings, WindowMessage } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses, verifyAccess } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, handleInterceptedRequest, refuseAccess } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getActiveAddressEntry, getActiveAddresses } from '../metadataUtils.js'
import { getSettings } from '../settings.js'
import { getTabState, updatePendingAccessRequests, getPendingAccessRequests, clearPendingAccessRequests } from '../storageVariables.js'
import { InterceptedRequest, WebsiteSocket } from '../../utils/requests.js'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBack } from '../messageSending.js'
import { Simulator } from '../../simulation/simulator.js'
import { ActiveAddressEntry } from '../../types/addressBookTypes.js'
import { PopupOrTabId, Website, WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import { PendingAccessRequest, PendingAccessRequests } from '../../types/accessRequest.js'

type OpenedDialogWithListeners = {
	popupOrTab: PopupOrTab
	onClosePopup: (id: number) => void
	onCloseTab: (id: number) => void
} | undefined

let openedDialog: OpenedDialogWithListeners = undefined

const pendingInterceptorAccessSemaphore = new Semaphore(1)

const onCloseWindowOrTab = async (simulator: Simulator, popupOrTabs: PopupOrTabId, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject signature
	if (openedDialog === undefined || openedDialog.popupOrTab.popupOrTab.id !== popupOrTabs.id || openedDialog.popupOrTab.popupOrTab.type !== popupOrTabs.type) return
	removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)

	openedDialog = undefined
	const pendingRequests = await clearPendingAccessRequests()
	for (const pendingRequest of pendingRequests) {
		const reply: InterceptorAccessReply = {
			originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
			requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
			accessRequestId: pendingRequest.accessRequestId,
			userReply: 'NoResponse' as const
		}
		await resolve(simulator, websiteTabConnections, reply, pendingRequest.request, pendingRequest.website)
	}
}

export async function resolveInterceptorAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, reply: InterceptorAccessReply) {
	const promises = await getPendingAccessRequests()
	const pendingRequest = promises.find((req) => req.accessRequestId === reply.accessRequestId)
	if (pendingRequest === undefined) throw new Error('Access request missing!')
	return await resolve(simulator, websiteTabConnections, reply, pendingRequest.request, pendingRequest.website)
}

export async function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray): Promise<readonly ActiveAddressEntry[]> {
	const addresses = websiteAccess.map((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address)).flat()
	const addressSet = new Set(addresses)
	return await Promise.all(Array.from(addressSet).map((x) => getActiveAddressEntry(x)))
}

export async function changeAccess(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply, website: Website, promptForAccessesIfNeeded: boolean = true) {
	if (confirmation.userReply === 'NoResponse') return
	await setAccess(website, confirmation.userReply === 'Approved', confirmation.requestAccessToAddress)
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, promptForAccessesIfNeeded, await getSettings())
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function updateInterceptorAccessViewWithPendingRequests() {
	const pendingAccessRequests = await getPendingAccessRequests()
	if (pendingAccessRequests.length > 0) await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: {
		activeAddresses: await getActiveAddresses(),
		pendingAccessRequests,
	} })
}

export async function askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const tabState = await getTabState(socket.tabId)
	if (tabState.signerAccounts.length !== 0) return tabState.signerAccounts

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && websiteSocketToString(message.data.socket) === websiteSocketToString(socket)) return future.resolve()
	})
	const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	try {
		channel.addEventListener('message', listener)
		const messageSent = sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'request_signer_to_eth_requestAccounts' as const, result: [] })
		if (messageSent) await future
	} finally {
		channel.removeEventListener('message', listener)
		channel.close()
	}
	return (await getTabState(socket.tabId)).signerAccounts
}

export async function requestAccessFromUser(
	simulator: Simulator,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest | undefined,
	requestAccessToAddress: ActiveAddressEntry | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
) {
	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const activeAddressEntry = activeAddress !== undefined ? await getActiveAddressEntry(activeAddress) : activeAddress
	const askForAddressAccess = requestAccessToAddress !== undefined && requestAccessToAddress.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined
	const closeWindowOrTabCallback = (popupOrTabId: PopupOrTabId) => onCloseWindowOrTab(simulator, popupOrTabId, websiteTabConnections) 
	const onCloseWindowCallback = async (id: number) => closeWindowOrTabCallback({ type: 'popup' as const, id })
	const onCloseTabCallback = async (id: number) => closeWindowOrTabCallback({ type: 'tab' as const, id })
	const pendingAccessRequests = new Future<PendingAccessRequests>()
	await pendingInterceptorAccessSemaphore.execute(async () => {
		const verifyPendingRequests = async () => {
			const previousRequests = await getPendingAccessRequests()
			if (previousRequests.length !== 0) {
				const previousRequest = previousRequests[0]
				if (previousRequest === undefined) throw new Error('missing previous request')
				if (await getPopupOrTabOnlyById(previousRequest.popupOrTabId) !== undefined) {
					return true
				} else {
					await clearPendingAccessRequests()
				}
			}
			return false
		}

		const justAddToPending = await verifyPendingRequests()
		const hasAccess = verifyAccess(websiteTabConnections, socket, true, website.websiteOrigin, activeAddressEntry, await getSettings())

		if (hasAccess === 'hasAccess') { // we already have access, just reply with the gate keeped request right away
			if (request !== undefined) await handleInterceptedRequest(undefined, website.websiteOrigin, website, simulator, socket, request, websiteTabConnections)
			return
		}
		if (hasAccess !== 'askAccess') return
		if (!justAddToPending) {
			addWindowTabListeners(onCloseWindowCallback, onCloseTabCallback)
			const popupOrTab = await openPopupOrTab({
				url: getHtmlFile('interceptorAccess'),
				type: 'popup',
				height: 800,
				width: 600,
			})
			if (popupOrTab === undefined) {
				if (request !== undefined) refuseAccess(websiteTabConnections, request)
				throw new Error('Opened dialog does not exist when expected in requestAccessFromUser function')
			}
			if (openedDialog) {
				removeWindowTabListeners(onCloseWindowCallback, onCloseTabCallback)
				await closePopupOrTabById(openedDialog.popupOrTab.popupOrTab)
			}
			openedDialog = { popupOrTab, onClosePopup: onCloseWindowCallback, onCloseTab: onCloseTabCallback,  }
		}

		if (openedDialog === undefined) {
			if (request !== undefined) refuseAccess(websiteTabConnections, request)
			throw new Error('Opened dialog does not exist when expected in requestAccessFromUser function')
		}
		const accessRequestId =  `${ accessAddress?.address } || ${ website.websiteOrigin }`
		const pendingRequest = {
			popupOrTabId: openedDialog.popupOrTab.popupOrTab,
			socket,
			request,
			accessRequestId,
			website,
			requestAccessToAddress: accessAddress,
			originalRequestAccessToAddress: accessAddress,
			associatedAddresses: requestAccessToAddress !== undefined ? await getAssociatedAddresses(settings, website.websiteOrigin, requestAccessToAddress) : [],
			signerAccounts: [],
			signerName: request !== undefined ? (await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)).signerName : 'NoSignerDetected',
			simulationMode: settings.simulationMode,
			activeAddress: activeAddress,
		}

		const pendingRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
			// check that it doesn't have access already
			if (verifyAccess(websiteTabConnections, socket, true, website.websiteOrigin, activeAddressEntry, await getSettings()) !== 'askAccess') return previousPendingAccessRequests
			
			// check that we are not tracking it already
			if (previousPendingAccessRequests.find((x) => x.accessRequestId === accessRequestId) === undefined) {
				return previousPendingAccessRequests.concat(pendingRequest)
			}
			return previousPendingAccessRequests
		})
		if (pendingRequests.current.find((x) => x.accessRequestId === accessRequestId) === undefined) return pendingAccessRequests.resolve(pendingRequests.current)

		if (pendingRequests.previous.find((x) => x.accessRequestId === accessRequestId) !== undefined) {
			if (request !== undefined) {
				replyToInterceptedRequest(websiteTabConnections, {
					uniqueRequestIdentifier: request.uniqueRequestIdentifier,
					method: request.method,
					error: METAMASK_ERROR_ALREADY_PENDING.error,
				})
			}
			return
		}
		if (justAddToPending) {
			if (pendingRequests.current.findIndex((x) => x.accessRequestId === accessRequestId) === 0) {
				await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: {
					activeAddresses: await getActiveAddresses(),
					pendingAccessRequests: pendingRequests.current,
				} })
			}
			await sendPopupMessageToOpenWindows({
				method: 'popup_interceptor_access_dialog_pending_changed',
				data: {
					activeAddresses: await getActiveAddresses(),
					pendingAccessRequests: pendingRequests.current,
				}
			})
			if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab.popupOrTab)
			return 
		}
		pendingAccessRequests.resolve(pendingRequests.current)
	})
}

async function resolve(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, accessReply: InterceptorAccessReply, request: InterceptedRequest | undefined, website: Website) {
	if (accessReply.userReply === 'NoResponse') {
		if (request !== undefined) refuseAccess(websiteTabConnections, request)
	} else {
		const userRequestedAddressChange = accessReply.requestAccessToAddress !== accessReply.originalRequestAccessToAddress
		if (!userRequestedAddressChange) {
			await changeAccess(simulator, websiteTabConnections, accessReply, website)
		} else {
			if (accessReply.requestAccessToAddress === undefined) throw new Error('Changed request to page level')
			await changeAccess(simulator, websiteTabConnections, accessReply, website, false)
			const settings = await getSettings()
			await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
				simulationMode: settings.simulationMode,
				activeAddress: accessReply.requestAccessToAddress,
			})
		}
	}
	
	const isAffectedEntry = (pending: PendingAccessRequest) => pending.website.websiteOrigin === website.websiteOrigin && (pending.requestAccessToAddress?.address === accessReply.requestAccessToAddress || pending.requestAccessToAddress?.address === accessReply.originalRequestAccessToAddress) 

	const pendingRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => previousPendingAccessRequests.filter((pending) => !isAffectedEntry(pending)))

	if (pendingRequests.current.length > 0) {
		sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: { activeAddresses: await getActiveAddresses(), pendingAccessRequests: pendingRequests.current } })
		return
	}

	if (openedDialog) {
		removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)
		await closePopupOrTabById(openedDialog.popupOrTab.popupOrTab)
		openedDialog = undefined
	}
	const affectedEntryWithPendingRequest = pendingRequests.previous.filter((pending): pending is PendingAccessRequest & { request: InterceptedRequest } => isAffectedEntry(pending) && pending.request !== undefined)

	await Promise.all(affectedEntryWithPendingRequest.map((r) => handleInterceptedRequest(undefined, r.website.websiteOrigin, r.website, simulator, r.socket, r.request, websiteTabConnections)))
}

export async function requestAddressChange(websiteTabConnections: WebsiteTabConnections, message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	const newRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
		if (message.data.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
		async function getProposedAddress() {
			if (message.method === 'popup_interceptorAccessRefresh' || message.data.newActiveAddress === 'signer') {
				const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, message.data.socket)
				return signerAccounts === undefined || signerAccounts.length === 0 ? undefined : signerAccounts[0]
			}
			return message.data.newActiveAddress
		}

		const proposedAddress = await getProposedAddress()
		const settings = await getSettings()
		const newActiveAddress = proposedAddress === undefined ? message.data.requestAccessToAddress : proposedAddress
		const newActiveAddressActiveAddress = await getActiveAddressEntry(newActiveAddress)
		const associatedAddresses = await getAssociatedAddresses(settings, message.data.website.websiteOrigin, newActiveAddressActiveAddress)
		
		return previousPendingAccessRequests.map((request) => {
			if (request.accessRequestId === message.data.accessRequestId) {
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
		data: {
			activeAddresses: await getActiveAddresses(),
			pendingAccessRequests: newRequests.current,
		}
	})
}

export async function interceptorAccessMetadataRefresh() {
	const settings = await getSettings()
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			activeAddresses: await getActiveAddresses(),
			pendingAccessRequests: await Promise.all((await getPendingAccessRequests()).map(async (request) => {
				const requestAccessTo = request.requestAccessToAddress === undefined ? undefined : request.requestAccessToAddress
				const signerName = request.request !== undefined ? (await getTabState(request.request?.uniqueRequestIdentifier.requestSocket.tabId)).signerName : 'NoSignerDetected'
				const associatedAddresses = await getAssociatedAddresses(settings, request.website.websiteOrigin, requestAccessTo)
				return {
					...request,
					signerName,
					associatedAddresses,
					requestAccessTo
				}
			}))
		}
	})
}

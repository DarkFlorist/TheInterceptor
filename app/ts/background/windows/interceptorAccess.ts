import { METAMASK_ERROR_ALREADY_PENDING } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import type { InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, Settings, WindowMessage } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses, verifyAccess } from '../accessManagement.js'
import { changeActiveAddressAndChain, handleInterceptedRequest, refuseAccess } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getActiveAddressEntry, getActiveAddresses } from '../metadataUtils.js'
import { getSettings } from '../settings.js'
import { getTabState, updatePendingAccessRequests, getPendingAccessRequests, clearPendingAccessRequests } from '../storageVariables.js'
import type { InterceptedRequest, WebsiteSocket } from '../../utils/requests.js'
import { replyToInterceptedRequest, sendSubscriptionReplyOrCallBack } from '../messageSending.js'
import type { PopupOrTabId, Website, WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import type { PendingAccessRequest } from '../../types/accessRequest.js'
import type { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../../simulation/serviceLifecycle.js'
import type { PublishRpcConnectionStatus } from '../rpcSlowRequestTracking.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'

type OpenedDialogWithListeners = {
	popupOrTab: PopupOrTab
	onClosePopup: (id: number) => void
	onCloseTab: (id: number) => void
} | undefined

let openedDialog: OpenedDialogWithListeners 

const pendingInterceptorAccessSemaphore = new Semaphore(1)

function isAccountConnectionRequest(request: InterceptedRequest | undefined) {
	return request?.method === 'eth_requestAccounts' || request?.method === 'wallet_requestPermissions'
}

const onCloseWindowOrTab = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, popupOrTabs: PopupOrTabId, websiteTabConnections: WebsiteTabConnections) => await pendingInterceptorAccessSemaphore.execute(async () => { // check if user has closed the window on their own, if so, reject signature
	if (openedDialog === undefined || openedDialog.popupOrTab.id !== popupOrTabs.id || openedDialog.popupOrTab.type !== popupOrTabs.type) return
	removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)

	openedDialog = undefined
	const pendingRequests = await clearPendingAccessRequests()
	for (const pendingRequest of pendingRequests) {
		const reply: InterceptorAccessReply = {
			originalRequestAccessToAddress: pendingRequest.originalRequestAccessToAddress?.address,
			requestAccessToAddress: pendingRequest.requestAccessToAddress?.address,
			accessRequestId: pendingRequest.accessRequestId,
			userReply: 'noResponse' as const
		}
		await resolve(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			reply,
			pendingRequest.request,
			pendingRequest.website,
			undefined,
		)
	}
})

export async function resolveInterceptorAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, reply: InterceptorAccessReply, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	return await pendingInterceptorAccessSemaphore.execute(async () => {
		const promises = await getPendingAccessRequests()
		const pendingRequest = promises.find((req) => req.accessRequestId === reply.accessRequestId)
		if (pendingRequest === undefined) throw new Error('Access request missing!')
		return await resolve(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			reply,
			pendingRequest.request,
			pendingRequest.website,
			publishRpcConnectionStatus,
		)
	})
}

export async function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray): Promise<AddressBookEntries> {
	const addresses = websiteAccess.flatMap((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address))
	const addressSet = new Set(addresses)
	return await Promise.all(Array.from(addressSet).map((x) => getActiveAddressEntry(x)))
}

async function changeAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply, website: Website, promptForAccessesIfNeeded = true, connectionEventExcludedSocket?: WebsiteSocket) {
	if (confirmation.userReply === 'noResponse') return
	await setAccess(website, confirmation.userReply === 'Approved', confirmation.requestAccessToAddress)
	await updateWebsiteApprovalAccesses(
		ethereum,
		tokenPriceService,
		resetSimulationServices,
		websiteTabConnections,
		await getSettings(),
		promptForAccessesIfNeeded,
		true,
		connectionEventExcludedSocket,
	)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function updateInterceptorAccessViewWithPendingRequests() {
	const pendingAccessRequests = await getPendingAccessRequests()
	if (pendingAccessRequests.length > 0) await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: {
		activeAddresses: await getActiveAddresses(),
		pendingAccessRequests,
	} })
}

export async function askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, requestAccounts = true) {
	const tabState = await getTabState(socket.tabId)
	if (tabState.signerAccounts.length !== 0) return tabState.signerAccounts

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && websiteSocketToString(message.data.socket) === websiteSocketToString(socket)) return future.resolve()
	})
	const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	try {
		channel.addEventListener('message', listener)
		const requestSignerAccountsMessage = requestAccounts
			? { type: 'result' as const, method: 'request_signer_to_eth_requestAccounts' as const, result: [] as const }
			: { type: 'result' as const, method: 'request_signer_to_eth_accounts' as const, result: [] as const }
		const messageSent = sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, requestSignerAccountsMessage)
		if (messageSent) await future
	} finally {
		channel.removeEventListener('message', listener)
		channel.close()
	}
	return (await getTabState(socket.tabId)).signerAccounts
}

export async function requestAccessFromUser(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
): Promise<void>
export async function requestAccessFromUser(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: undefined,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: undefined,
): Promise<void>
export async function requestAccessFromUser(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest | undefined,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: PublishRpcConnectionStatus | undefined,
) {
	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const activeAddressEntry = activeAddress !== undefined ? await getActiveAddressEntry(activeAddress) : activeAddress
	const askForAddressAccess = requestAccessToAddress !== undefined && requestAccessToAddress.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined
	const sendConnectionEvents = !isAccountConnectionRequest(request)
	const closeWindowOrTabCallback = (popupOrTabId: PopupOrTabId) => onCloseWindowOrTab(ethereum, tokenPriceService, resetSimulationServices, popupOrTabId, websiteTabConnections)
	const onCloseWindowCallback = async (id: number) => closeWindowOrTabCallback({ type: 'popup' as const, id })
	const onCloseTabCallback = async (id: number) => closeWindowOrTabCallback({ type: 'tab' as const, id })
	await pendingInterceptorAccessSemaphore.execute(async () => {
		const verifyPendingRequests = async () => {
			const previousRequests = await getPendingAccessRequests()
			if (previousRequests.length !== 0) {
				const previousRequest = previousRequests[0]
				if (previousRequest === undefined) throw new Error('missing previous request')
				if (await getPopupOrTabById(previousRequest.popupOrTabId) !== undefined) {
					return true
				}
				await clearPendingAccessRequests()
			}
			return false
		}

		const justAddToPending = await verifyPendingRequests()
		const hasAccess = verifyAccess(websiteTabConnections, socket, true, website.websiteOrigin, activeAddressEntry, await getSettings(), sendConnectionEvents)
		if (hasAccess === 'hasAccess') { // we already have access, just reply with the gate keeped request right away
			if (request !== undefined) {
				if (publishRpcConnectionStatus === undefined) throw new Error('RPC connection status publisher is required to replay an intercepted request.')
				await handleInterceptedRequest(undefined, website.websiteOrigin, website, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)
			}
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
				await closePopupOrTabById(openedDialog.popupOrTab)
			}
			openedDialog = { popupOrTab, onClosePopup: onCloseWindowCallback, onCloseTab: onCloseTabCallback,  }
		}

		if (openedDialog === undefined) {
			if (request !== undefined) refuseAccess(websiteTabConnections, request)
			throw new Error('Opened dialog does not exist when expected in requestAccessFromUser function')
		}
		const accessRequestId =  `${ accessAddress?.address } || ${ website.websiteOrigin }`
		const pendingRequest = {
			popupOrTabId: openedDialog.popupOrTab,
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
			if (verifyAccess(websiteTabConnections, socket, true, website.websiteOrigin, activeAddressEntry, await getSettings(), sendConnectionEvents) !== 'askAccess') return previousPendingAccessRequests

			// check that we are not tracking it already
			if (previousPendingAccessRequests.find((x) => x.accessRequestId === accessRequestId) === undefined) {
				return previousPendingAccessRequests.concat(pendingRequest)
			}
			return previousPendingAccessRequests
		})
		const oldPendingRequest = pendingRequests.previous.find((x) => x.accessRequestId === accessRequestId)
		if (oldPendingRequest !== undefined) {
			if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab)
			if (request !== undefined) {
				replyToInterceptedRequest(websiteTabConnections, {
					type: 'result',
					uniqueRequestIdentifier: request.uniqueRequestIdentifier,
					method: request.method,
					error: METAMASK_ERROR_ALREADY_PENDING.error,
				})
			}
			return
		}
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
		if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab)
	})
}

async function resolve(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, accessReply: InterceptorAccessReply, request: InterceptedRequest | undefined, website: Website, publishRpcConnectionStatus: PublishRpcConnectionStatus | undefined) {
	if (accessReply.userReply === 'noResponse') {
		if (request !== undefined) refuseAccess(websiteTabConnections, request)
	} else {
		const userRequestedAddressChange = accessReply.requestAccessToAddress !== accessReply.originalRequestAccessToAddress
		const replyCompletesAccountRequest = request !== undefined && isAccountConnectionRequest(request)
		const connectionEventExcludedSocket = replyCompletesAccountRequest ? request.uniqueRequestIdentifier.requestSocket : undefined
		if (!userRequestedAddressChange) {
			await changeAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, accessReply, website, true, connectionEventExcludedSocket)
		} else {
			if (accessReply.requestAccessToAddress === undefined) throw new Error('Changed request to page level')
			await changeAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, accessReply, website, false, connectionEventExcludedSocket)
			const settings = await getSettings()
			await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: settings.simulationMode,
				activeAddress: accessReply.requestAccessToAddress,
				...(replyCompletesAccountRequest ? { accountChangeExcludedSocket: request.uniqueRequestIdentifier.requestSocket } : {}),
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
		await closePopupOrTabById(openedDialog.popupOrTab)
		openedDialog = undefined
	}
	const affectedEntryWithPendingRequest = pendingRequests.previous.filter((pending): pending is PendingAccessRequest & { request: InterceptedRequest } => isAffectedEntry(pending) && pending.request !== undefined)

	if (affectedEntryWithPendingRequest.length === 0) return
	if (publishRpcConnectionStatus === undefined) throw new Error('RPC connection status publisher is required to replay intercepted requests.')
	await Promise.all(affectedEntryWithPendingRequest.map((r) => handleInterceptedRequest(undefined, r.website.websiteOrigin, r.website, ethereum, tokenPriceService, resetSimulationServices, r.socket, r.request, websiteTabConnections, publishRpcConnectionStatus)))
}

export async function requestAddressChange(websiteTabConnections: WebsiteTabConnections, message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	const newRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
		if (message.data.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
		async function getProposedAddress() {
			if (message.method === 'popup_interceptorAccessRefresh') {
				const tabState = await getTabState(message.data.socket.tabId)
				return tabState.signerAccounts[0]
			}
			if (message.data.newActiveAddress === 'signer') {
				const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, message.data.socket)
				return signerAccounts[0]
			}
			return message.data.newActiveAddress
		}

		const proposedAddress = await getProposedAddress()
		const settings = await getSettings()
		const newActiveAddress = proposedAddress === undefined ? message.data.requestAccessToAddress : proposedAddress
		const requestAccessToAddress = await getActiveAddressEntry(newActiveAddress)
		const associatedAddresses = await getAssociatedAddresses(settings, message.data.website.websiteOrigin, requestAccessToAddress)
		return previousPendingAccessRequests.map((request) => {
			if (request.accessRequestId === message.data.accessRequestId) return { ...request, associatedAddresses, requestAccessToAddress }
			return request
		})
	})
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: { activeAddresses: await getActiveAddresses(), pendingAccessRequests: newRequests.current } })
}

export async function interceptorAccessMetadataRefresh() {
	const settings = await getSettings()
	await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			activeAddresses: await getActiveAddresses(),
			pendingAccessRequests: await Promise.all((await getPendingAccessRequests()).map(async (request) => {
				const requestAccessToAddress = request.requestAccessToAddress === undefined ? undefined : request.requestAccessToAddress
				const signerName = request.request !== undefined ? (await getTabState(request.request?.uniqueRequestIdentifier.requestSocket.tabId)).signerName : 'NoSignerDetected'
				const associatedAddresses = await getAssociatedAddresses(settings, request.website.websiteOrigin, requestAccessToAddress)
				return {
					...request,
					signerName,
					associatedAddresses,
					requestAccessToAddress
				}
			}))
		}
	})
}

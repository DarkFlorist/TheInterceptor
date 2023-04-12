import { Future } from '../../utils/future.js'
import { ExternalPopupMessage, InterceptedRequest, InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, PendingAccessRequest, Settings, WebsiteAccessArray, WindowMessage } from '../../utils/interceptor-messages.js'
import { AddressInfo, AddressInfoEntry, Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, handleContentScriptMessage, postMessageIfStillConnected, refuseAccess } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { getPendingInterceptorAccessRequestPromise, setPendingInterceptorAccessRequestPromise, getSignerName, getTabState, getSettings, updatePendingAccessRequests } from '../settings.js'

let openedInterceptorAccessWindow: browser.windows.Window | null = null

let pendingInterceptorAccess: {
	future: Future<InterceptorAccessReply>
	websiteOrigin: string,
	requestAccessToAddress: bigint | undefined,
} | undefined = undefined

const onCloseWindow = async (windowId: number) => { // check if user has closed the window on their own, if so, reject signature
	if (openedInterceptorAccessWindow === null || openedInterceptorAccessWindow.id !== windowId) return
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.future.resolve({
		approval: 'NoResponse',
		websiteOrigin: pendingInterceptorAccess.websiteOrigin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress,
		originalRequestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
	pendingInterceptorAccess = undefined
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener(onCloseWindow)
}

export async function resolveExistingInterceptorAccessAsNoResponse(websiteTabConnections: WebsiteTabConnections, ) {
	if (pendingInterceptorAccess === undefined) return
	await resolveInterceptorAccess(websiteTabConnections, {
		approval: 'NoResponse',
		websiteOrigin: pendingInterceptorAccess.websiteOrigin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress,
		originalRequestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
}

export async function resolveInterceptorAccess(websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply) {
	if (pendingInterceptorAccess === undefined) {
		const data = await getPendingInterceptorAccessRequestPromise()
		if (data === undefined) return
		return await resolve(websiteTabConnections, confirmation)
	}
	if (confirmation.websiteOrigin !== pendingInterceptorAccess.websiteOrigin || confirmation.originalRequestAccessToAddress !== pendingInterceptorAccess.requestAccessToAddress) return

	pendingInterceptorAccess.future.resolve(confirmation)
}

export function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray, addressInfos: readonly AddressInfo[]): AddressInfoEntry[] {
	const addresses = websiteAccess.map((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address)).flat()
	const addressSet = new Set(addresses)
	return Array.from(addressSet).map((x) => findAddressInfo(x, addressInfos))
}

export async function addPendingAccessRequestAndUpdateBadge(pendingAccessRequest: PendingAccessRequest) {
	await updatePendingAccessRequests((previousPendingAccessRequests) => {
		if (previousPendingAccessRequests.find((x) => x.website.websiteOrigin === pendingAccessRequest.website.websiteOrigin && x.requestAccessToAddress === pendingAccessRequest.requestAccessToAddress) === undefined) {
			return previousPendingAccessRequests.concat(pendingAccessRequest)
		}
		return previousPendingAccessRequests
	})
	await sendPopupMessageToOpenWindows({ method: 'popup_notification_changed' })
	await updateExtensionBadge()
}

export async function removePendingAccessRequestAndUpdateBadge(websiteOrigin: string, requestAccessToAddress: bigint | undefined) {
	await updatePendingAccessRequests((previousPendingAccessRequests) => {
		return previousPendingAccessRequests.filter((x) => !(x.website.websiteOrigin === websiteOrigin && x.requestAccessToAddress === requestAccessToAddress))
	})
	await sendPopupMessageToOpenWindows({ method: 'popup_notification_changed' })
	await updateExtensionBadge()
}

export async function changeAccess(websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply, website: Website, promptForAccessesIfNeeded: boolean = true) {
	if (confirmation.approval === 'NoResponse') return
	await setAccess(website, confirmation.approval === 'Approved', confirmation.requestAccessToAddress)
	updateWebsiteApprovalAccesses(websiteTabConnections, promptForAccessesIfNeeded, await getSettings())
	await removePendingAccessRequestAndUpdateBadge(website.websiteOrigin, confirmation.requestAccessToAddress)
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
		const messageSent = postMessageIfStillConnected(websiteTabConnections, socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
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
	associatedAddresses: AddressInfoEntry[],
	settings: Settings,
) {
	const rejectReply = () => {
		if (request) refuseAccess(websiteTabConnections, socket, request)
	}

	if (pendingInterceptorAccess !== undefined) return rejectReply()

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && settings.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address)?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_interceptorAccessReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		return await sendPopupMessageToOpenWindows({
			method: 'popup_interceptorAccessDialog',
			data: {
				website: website,
				requestAccessToAddress: accessAddress,
				originalRequestAccessToAddress: accessAddress,
				associatedAddresses: associatedAddresses,
				addressInfos: settings.userAddressBook.addressInfos,
				signerAccounts: [],
				signerName: await getSignerName(),
				simulationMode: settings.simulationMode,
				socket: socket,
			}
		})
	}

	try {
		pendingInterceptorAccess = {
			future: new Future<InterceptorAccessReply>(),
			websiteOrigin: website.websiteOrigin,
			requestAccessToAddress: accessAddress?.address,
		}

		await addPendingAccessRequestAndUpdateBadge({
			request,
			socket,
			website,
			requestAccessToAddress: accessAddress?.address,
		})

		const oldPromise = await getPendingInterceptorAccessRequestPromise()
		if (oldPromise !== undefined) {
			if ((await browser.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
				return rejectReply()
			}
			await setPendingInterceptorAccessRequestPromise(undefined)
		}

		browser.runtime.onMessage.addListener(windowReadyAndListening)

		openedInterceptorAccessWindow = await browser.windows.create({
			url: getHtmlFile('interceptorAccess'),
			type: 'popup',
			height: 600,
			width: 600,
		})

		if (openedInterceptorAccessWindow?.id === undefined) {
			return rejectReply()
		}
		browser.windows.onRemoved.addListener(onCloseWindow)
		await setPendingInterceptorAccessRequestPromise({
			website: website,
			dialogId: openedInterceptorAccessWindow.id,
			socket: socket,
			requestAccessToAddress: accessAddress,
			request: request,
		})
		const confirmation = await pendingInterceptorAccess.future
		return await resolve(websiteTabConnections, confirmation)
	} finally {
		pendingInterceptorAccess = undefined
		browser.windows.onRemoved.removeListener(onCloseWindow)
		browser.windows.onRemoved.removeListener(windowReadyAndListening)
	}
}

async function resolve(websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccessReply) {
	const data = await getPendingInterceptorAccessRequestPromise()
	await setPendingInterceptorAccessRequestPromise(undefined)
	openedInterceptorAccessWindow = null
	if (data === undefined) throw new Error('data was undefined')

	if (confirmation.approval === 'NoResponse') {
		if (data.request !== undefined) {
			refuseAccess(websiteTabConnections, data.socket, data.request)
		}
		return
	}

	const userRequestedAddressChange = confirmation.requestAccessToAddress !== data.requestAccessToAddress?.address

	pendingInterceptorAccess = undefined
	if (!userRequestedAddressChange) {
		await changeAccess(websiteTabConnections, confirmation, data.website)
		if (data.request !== undefined) {
			await handleContentScriptMessage(websiteTabConnections, data.socket, data.request, data.website)
		}
		return
	} else {
		if (data.request !== undefined) refuseAccess(websiteTabConnections, data.socket, data.request)
		if (confirmation.requestAccessToAddress === undefined) throw new Error('Changed request to page level')

		// clear the original pending request, which was made with other account
		await removePendingAccessRequestAndUpdateBadge(data.website.websiteOrigin, data.requestAccessToAddress?.address)

		await changeAccess(websiteTabConnections, confirmation, data.website, false)
		const settings = await getSettings()
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: settings.simulationMode,
			activeAddress: confirmation.requestAccessToAddress,
		})
	}
}

export async function requestAddressChange(websiteTabConnections: WebsiteTabConnections, message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
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
	const newActiveAddress: bigint = proposedAddress === undefined ? message.options.requestAccessToAddress : proposedAddress
	const newActiveAddressAddressInfo = findAddressInfo(newActiveAddress, settings.userAddressBook.addressInfos)
	const associatedAddresses = getAssociatedAddresses(settings, message.options.website.websiteOrigin, newActiveAddressAddressInfo)
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			website: message.options.website,
			requestAccessToAddress: newActiveAddressAddressInfo,
			originalRequestAccessToAddress: findAddressInfo(message.options.requestAccessToAddress, settings.userAddressBook.addressInfos),
			associatedAddresses: associatedAddresses,
			addressInfos: settings.userAddressBook.addressInfos,
			signerAccounts: [],
			signerName: await getSignerName(),
			simulationMode: settings.simulationMode,
			socket: message.options.socket,
		}
	})
}

import { Future } from '../../utils/future.js'
import { ExternalPopupMessage, InterceptedRequest, InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, PendingAccessRequestArray, WebsiteAccessArray, WindowMessage } from '../../utils/interceptor-messages.js'
import { AddressInfoEntry, Website, WebsiteSocket } from '../../utils/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, handleContentScriptMessage, postMessageIfStillConnected, refuseAccess } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { getPendingInterceptorAccessRequestPromise, savePendingAccessRequests, saveWebsiteAccess, savePendingInterceptorAccessRequestPromise } from '../settings.js'

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

export async function resolveExistingInterceptorAccessAsNoResponse() {
	if (pendingInterceptorAccess === undefined) return
	await resolveInterceptorAccess({
		approval: 'NoResponse',
		websiteOrigin: pendingInterceptorAccess.websiteOrigin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress,
		originalRequestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
}

export async function resolveInterceptorAccess(confirmation: InterceptorAccessReply) {
	if (pendingInterceptorAccess === undefined) {
		const data = await getPendingInterceptorAccessRequestPromise()
		if (data === undefined) return
		return await resolve(confirmation)
	}
	if (confirmation.websiteOrigin !== pendingInterceptorAccess.websiteOrigin || confirmation.originalRequestAccessToAddress !== pendingInterceptorAccess.requestAccessToAddress) return

	pendingInterceptorAccess.future.resolve(confirmation)
}

export function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray): AddressInfoEntry[] {
	if (globalThis.interceptor.settings === undefined) return []
	const addresses = websiteAccess.map((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address)).flat()
	const addressSet = new Set(addresses)
	const infos = globalThis.interceptor.settings.userAddressBook.addressInfos
	return Array.from(addressSet).map((x) => findAddressInfo(x, infos))
}

export async function setPendingAccessRequests(pendingAccessRequest: PendingAccessRequestArray) {
	if (globalThis.interceptor.settings === undefined) return
	globalThis.interceptor.settings.pendingAccessRequests = pendingAccessRequest
	savePendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(confirmation: InterceptorAccessReply, website: Website, promptForAccessesIfNeeded: boolean = true) {
	if (globalThis.interceptor.settings === undefined) return
	if (confirmation.approval === 'NoResponse') return
	globalThis.interceptor.settings.websiteAccess = setAccess(globalThis.interceptor.settings.websiteAccess, website, confirmation.approval === 'Approved', confirmation.requestAccessToAddress)
	saveWebsiteAccess(globalThis.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses(promptForAccessesIfNeeded)
	sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.filter((x) => !(x.website.websiteOrigin === website.websiteOrigin && x.requestAccessToAddress === confirmation.requestAccessToAddress)))
}

async function askForSignerAccountsFromSignerIfNotAvailable(socket: WebsiteSocket) {
	const signerState = globalThis.interceptor.websiteTabSignerStates.get(socket.tabId)
	if (signerState?.signerAccounts !== undefined) return signerState.signerAccounts

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && websiteSocketToString(message.data.socket) === websiteSocketToString(socket)) return future.resolve()
	})
	const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	try {
		channel.addEventListener('message', listener)
		const messageSent = postMessageIfStillConnected(socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
		if (messageSent) await future
	} finally {
		channel.removeEventListener('message', listener)
		channel.close()
	}
	return globalThis.interceptor.websiteTabSignerStates.get(socket.tabId)?.signerAccounts
}

export async function requestAccessFromUser(
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest | undefined,
	requestAccessToAddress: AddressInfoEntry | undefined,
	associatedAddresses: AddressInfoEntry[]
) {
	const rejectReply = () => {
		if (request) refuseAccess(socket, request)
	}
	if (globalThis.interceptor.settings === undefined) return rejectReply

	if (pendingInterceptorAccess !== undefined) return rejectReply()

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && globalThis.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address)?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_interceptorAccessReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		if (globalThis.interceptor.settings === undefined) return rejectReply()
		return await sendPopupMessageToOpenWindows({
			method: 'popup_interceptorAccessDialog',
			data: {
				website: website,
				requestAccessToAddress: accessAddress,
				originalRequestAccessToAddress: accessAddress,
				associatedAddresses: associatedAddresses,
				addressInfos: globalThis.interceptor.settings.userAddressBook.addressInfos,
				signerAccounts: [],
				signerName: globalThis.interceptor.signerName,
				simulationMode: globalThis.interceptor.settings.simulationMode,
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

		if (globalThis.interceptor.settings.pendingAccessRequests.find((x) => x.website.websiteOrigin === website.websiteOrigin && x.requestAccessToAddress === accessAddress?.address) === undefined) {
			// we didn't have this request pending already, add it to the list
			await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.concat({
				request,
				socket,
				website,
				requestAccessToAddress: accessAddress?.address,
			}))
			sendPopupMessageToOpenWindows({ method: 'popup_notification_added' })
		}

		const oldPromise = await getPendingInterceptorAccessRequestPromise()
		if (oldPromise !== undefined) {
			if ((await browser.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
				return rejectReply()
			}
			await savePendingInterceptorAccessRequestPromise(undefined)
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
		await savePendingInterceptorAccessRequestPromise({
			website: website,
			dialogId: openedInterceptorAccessWindow.id,
			socket: socket,
			requestAccessToAddress: accessAddress,
			request: request,
		})
		const confirmation = await pendingInterceptorAccess.future
		return await resolve(confirmation)
	} finally {
		pendingInterceptorAccess = undefined
		browser.windows.onRemoved.removeListener(onCloseWindow)
		browser.windows.onRemoved.removeListener(windowReadyAndListening)
	}
}

async function resolve(confirmation: InterceptorAccessReply) {
	const data = await getPendingInterceptorAccessRequestPromise()
	savePendingInterceptorAccessRequestPromise(undefined)
	openedInterceptorAccessWindow = null
	if (data === undefined) throw new Error('data was undefined')

	if (confirmation.approval === 'NoResponse') {
		if (data.request !== undefined) {
			refuseAccess(data.socket, data.request)
		}
		return
	}

	const userRequestedAddressChange = confirmation.requestAccessToAddress !== data.requestAccessToAddress?.address

	pendingInterceptorAccess = undefined
	if (!userRequestedAddressChange) {
		await changeAccess(confirmation, data.website)
		if (data.request !== undefined) {
			await handleContentScriptMessage(data.socket, data.request, data.website)
		}
		return
	} else {
		if (data.request !== undefined) {
			refuseAccess(data.socket, data.request)
		}

		if (confirmation.requestAccessToAddress === undefined) throw new Error('Changed request to page level')

		// clear the original pending request, which was made with other account
		if (globalThis.interceptor.settings !== undefined) {
			await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.filter((x) => !(x.website.websiteOrigin === data.website.websiteOrigin && x.requestAccessToAddress === data.requestAccessToAddress?.address)))
		}

		await changeAccess(confirmation, data.website, false)
		await changeActiveAddressAndChainAndResetSimulation(confirmation.requestAccessToAddress, 'noActiveChainChange')
	}
}

export async function requestAddressChange(message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	if (globalThis.interceptor.settings === undefined) return
	if (message.options.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')

	async function getProposedAddress() {
		if (message.method === 'popup_interceptorAccessRefresh' || message.options.newActiveAddress === 'signer') {
			const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(message.options.socket)
			return signerAccounts === undefined || signerAccounts.length == 0 ? undefined : signerAccounts[0]
		}
		return message.options.newActiveAddress
	}

	const proposedAddress = await getProposedAddress()

	const newActiveAddress: bigint = proposedAddress === undefined ? message.options.requestAccessToAddress : proposedAddress
	const newActiveAddressAddressInfo = findAddressInfo(newActiveAddress, globalThis.interceptor.settings.userAddressBook.addressInfos)
	const associatedAddresses = getAssociatedAddresses(globalThis.interceptor.settings, message.options.website.websiteOrigin, newActiveAddressAddressInfo)
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			website: message.options.website,
			requestAccessToAddress: newActiveAddressAddressInfo,
			originalRequestAccessToAddress: findAddressInfo(message.options.requestAccessToAddress, globalThis.interceptor.settings.userAddressBook.addressInfos),
			associatedAddresses: associatedAddresses,
			addressInfos: globalThis.interceptor.settings.userAddressBook.addressInfos,
			signerAccounts: [],
			signerName: globalThis.interceptor.signerName,
			simulationMode: globalThis.interceptor.settings.simulationMode,
			socket: message.options.socket,
		}
	})
}

import { addressString } from '../../utils/bigint.js'
import { Future } from '../../utils/future.js'
import { InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, PopupMessage, WebsiteAccessArray, WebsiteSocket, WindowMessage } from '../../utils/interceptor-messages.js'
import { AddressInfoEntry, PendingAccessRequestArray, Website } from '../../utils/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, postMessageIfStillConnected } from '../background.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, getSocketFromPort, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { getPendingInterceptorAccessRequestPromise, savePendingAccessRequests, saveWebsiteAccess, savePendingInterceptorAccessRequestPromise } from '../settings.js'

let openedInterceptorAccessWindow: browser.windows.Window | null = null

let pendingInterceptorAccess: {
	future: Future<InterceptorAccessReply>
	websiteOrigin: string,
	requestAccessToAddress: bigint | undefined,
} | undefined = undefined

const onCloseWindow = async () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.future.resolve({
		approval: 'NoResponse',
		websiteOrigin: pendingInterceptorAccess.websiteOrigin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener(onCloseWindow)
}

export async function resolveExistingInterceptorAccessAsNoResponse() {
	if (pendingInterceptorAccess === undefined) return
	await resolveInterceptorAccess({
		approval: 'NoResponse',
		websiteOrigin: pendingInterceptorAccess.websiteOrigin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
}

export async function resolveInterceptorAccess(confirmation: InterceptorAccessReply) {
	if (pendingInterceptorAccess === undefined) {
		const data = await getPendingInterceptorAccessRequestPromise()
		if (data === undefined) return
		const resolved = await resolve(confirmation)
		console.log(resolved)
		throw new Error('TODO, implement logic when we have resolved the access request and we need to forward our message back to interceptor for processing')
		///return sendMessageToContentScript(data.tabId, data.connectionName, resolved, data.request)
	}
	if (confirmation.websiteOrigin !== pendingInterceptorAccess.websiteOrigin || confirmation.requestAccessToAddress !== pendingInterceptorAccess.requestAccessToAddress) return

	pendingInterceptorAccess.future.resolve(confirmation)
	if (openedInterceptorAccessWindow !== null && openedInterceptorAccessWindow.id) {
		browser.windows.onRemoved.removeListener(onCloseWindow)
	}
	openedInterceptorAccessWindow = null
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
	const addresses = globalThis.interceptor.settings.pendingAccessRequests.map((x) => x.requestAccessToAddress === undefined ? [] : x.requestAccessToAddress).flat()
	const addressSet = new Set(addresses)
	const infos = globalThis.interceptor.settings.userAddressBook.addressInfos
	globalThis.interceptor.pendingAccessMetadata = Array.from(addressSet).map((x) => [addressString(x), findAddressInfo(BigInt(x), infos)])
	savePendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(confirmation: InterceptorAccessReply, website: Website) {
	if (globalThis.interceptor.settings === undefined) return
	if (confirmation.approval === 'NoResponse') return

	globalThis.interceptor.settings.websiteAccess = setAccess(globalThis.interceptor.settings.websiteAccess, website, confirmation.approval === 'Approved', confirmation.requestAccessToAddress)
	globalThis.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(globalThis.interceptor.settings.websiteAccess)
	saveWebsiteAccess(globalThis.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.filter((x) => !(x.website.websiteOrigin === website.websiteOrigin && x.requestAccessToAddress === confirmation.requestAccessToAddress)))
}

async function askForSignerAccountsFromSignerIfNotAvailable(port: browser.runtime.Port) {
	if (globalThis.interceptor.signerAccounts !== undefined) return globalThis.interceptor.signerAccounts
	const portSenderId = port.sender?.id
	if (portSenderId === undefined) return globalThis.interceptor.signerAccounts
	const tabId = port.sender?.tab?.id
	if (tabId === undefined) return []

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && message.data.portSenderId === portSenderId) return future.resolve()
	})
	const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
	try {
		channel.addEventListener('message', listener)
		const messageSent = postMessageIfStillConnected(getSocketFromPort(port), {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
		if (messageSent) await future
	} finally {
		channel.removeEventListener('message', listener)
		channel.close()
	}
	return globalThis.interceptor.signerAccounts
}

type RequestAccessFromUserReply = {
	requestAccessToAddress: bigint | undefined
	approved: boolean
	userRequestedAddressChange: boolean,
}

export async function requestAccessFromUser(
	socket: WebsiteSocket,
	website: Website,
	requestAccessToAddress: AddressInfoEntry | undefined,
	associatedAddresses: AddressInfoEntry[]
): Promise<RequestAccessFromUserReply> {
	const rejectReply = { requestAccessToAddress: requestAccessToAddress?.address, approved: false, userRequestedAddressChange: false }
	if (globalThis.interceptor.settings === undefined) return rejectReply
	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && globalThis.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address)?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	if (globalThis.interceptor.settings.pendingAccessRequests.find((x) => x.website.websiteOrigin === website.websiteOrigin && x.requestAccessToAddress === accessAddress?.address) === undefined) {
		// we didn't have this request pending already, add it to the list
		await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.concat({
			socket,
			website,
			requestAccessToAddress: accessAddress?.address,
		}))
		sendPopupMessageToOpenWindows({ method: 'popup_notification_added' })
	}

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = PopupMessage.parse(msg)
		if (message.method !== 'popup_interceptorAccessReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		if (globalThis.interceptor.settings === undefined) return rejectReply
		return await sendPopupMessageToOpenWindows({
			method: 'popup_interceptorAccessDialog',
			data: {
				website: website,
				requestAccessToAddress: accessAddress,
				associatedAddresses: associatedAddresses,
				addressInfos: globalThis.interceptor.settings.userAddressBook.addressInfos,
				signerAccounts: [],
				signerName: globalThis.interceptor.signerName,
				simulationMode: globalThis.interceptor.settings.simulationMode,
			}
		})
	}

	if (pendingInterceptorAccess !== undefined) {
		if (pendingInterceptorAccess.websiteOrigin === website.websiteOrigin && pendingInterceptorAccess.requestAccessToAddress === accessAddress?.address) {
			return rejectReply // there's already one pending request, and it's different access request
		}
	}

	const oldPromise = await getPendingInterceptorAccessRequestPromise()
	if (oldPromise !== undefined) {
		if ((await chrome.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
			if (oldPromise.website.websiteOrigin === website.websiteOrigin && oldPromise.requestAccessToAddress === accessAddress?.address) {
				return rejectReply
			}
		}
		await savePendingInterceptorAccessRequestPromise(undefined)
	}

	pendingInterceptorAccess = {
		future: new Future<InterceptorAccessReply>(),
		websiteOrigin: website.websiteOrigin,
		requestAccessToAddress: accessAddress?.address,
	}
	browser.runtime.onMessage.addListener(windowReadyAndListening)

	openedInterceptorAccessWindow = await browser.windows.create(
		{
			url: getHtmlFile('interceptorAccess'),
			type: 'popup',
			height: 600,
			width: 600,
		}
	)

	if (openedInterceptorAccessWindow?.id === undefined) return rejectReply
	browser.windows.onRemoved.addListener(onCloseWindow)
	await savePendingInterceptorAccessRequestPromise({
		website: website,
		dialogId: openedInterceptorAccessWindow.id,
		socket: socket,
		requestAccessToAddress: accessAddress,
	})
	const confirmation = await pendingInterceptorAccess.future
	return await resolve(confirmation)
}

async function resolve(confirmation: InterceptorAccessReply) {
	const data = await getPendingInterceptorAccessRequestPromise()
	if (data === undefined) return {
		requestAccessToAddress: confirmation.requestAccessToAddress,
		approved: confirmation.approval === 'Rejected',
		userRequestedAddressChange: false,
	}
	savePendingInterceptorAccessRequestPromise(undefined)
	browser.windows.onRemoved.removeListener(onCloseWindow)
	const userRequestedAddressChange = confirmation.requestAccessToAddress !== data.requestAccessToAddress

	if (userRequestedAddressChange) {
		// clear the original pending request, which was made with other account
		if (globalThis.interceptor.settings !== undefined) {
			await setPendingAccessRequests(globalThis.interceptor.settings.pendingAccessRequests.filter((x) => !(x.website.websiteOrigin === confirmation.websiteOrigin && x.requestAccessToAddress === data.requestAccessToAddress)))
		}
		// change address
		if (confirmation.requestAccessToAddress !== undefined) {
			await changeActiveAddressAndChainAndResetSimulation(confirmation.requestAccessToAddress, 'noActiveChainChange')
		}
	}

	await changeAccess(confirmation, data.website)
	pendingInterceptorAccess = undefined
	return {
		requestAccessToAddress: confirmation.requestAccessToAddress,
		approved: confirmation.approval === 'Approved',
		userRequestedAddressChange: userRequestedAddressChange, // if true, the access given was not for the original address
	}
}

export async function requestAddressChange(port: browser.runtime.Port | undefined, website: Website, options: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	if (globalThis.interceptor.settings === undefined) return
	if (options.options.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
	if (port === undefined) throw new Error('Requesting account change on site that we cannot connect anymore')

	async function getProposedAddress(port: browser.runtime.Port, confirmation: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
		if (confirmation.method === 'popup_interceptorAccessRefresh' || confirmation.options.newActiveAddress === 'signer') {
			const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(port)
			return signerAccounts === undefined || signerAccounts.length == 0 ? undefined : signerAccounts[0]
		}
		return confirmation.options.newActiveAddress
	}

	const proposedAddress = await getProposedAddress(port, options)

	const newActiveAddress: bigint = proposedAddress === undefined ? options.options.requestAccessToAddress : proposedAddress
	const newActiveAddressAddressInfo = findAddressInfo(newActiveAddress, globalThis.interceptor.settings.userAddressBook.addressInfos)
	const associatedAddresses = getAssociatedAddresses(globalThis.interceptor.settings, website.websiteOrigin, newActiveAddressAddressInfo)
	return await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			website,
			requestAccessToAddress: newActiveAddressAddressInfo,
			associatedAddresses: associatedAddresses,
			addressInfos: globalThis.interceptor.settings.userAddressBook.addressInfos,
			signerAccounts: [],
			signerName: globalThis.interceptor.signerName,
			simulationMode: globalThis.interceptor.settings.simulationMode,
		}
	})
}

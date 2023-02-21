import { addressString } from '../../utils/bigint.js'
import { Future } from '../../utils/future.js'
import { InterceptorAccessOptions, PopupMessage, WindowMessage } from '../../utils/interceptor-messages.js'
import { AddressInfoEntry, PendingAccessRequestArray } from '../../utils/user-interface-types.js'
import { getAssociatedAddresses, setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { changeActiveAddressAndChainAndResetSimulation, postMessageIfStillConnected } from '../background.js'
import { createInternalMessageListener, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { savePendingAccessRequests, saveWebsiteAccess, WebsiteAccessArray } from '../settings.js'

let openedInterceptorAccessWindow: browser.windows.Window | null = null

let pendingInterceptorAccess: {
	future: Future<InterceptorAccessOptions>
	origin: string,
	requestAccessToAddress: bigint | undefined,
} | undefined = undefined

const onCloseWindow = () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.future.resolve({
		type: 'approval',
		approval: 'NoResponse',
		origin: pendingInterceptorAccess.origin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
	pendingInterceptorAccess = undefined
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener(onCloseWindow)
}

export async function resolveExistingInterceptorAccessAsNoResponse() {
	if (pendingInterceptorAccess === undefined) return
	await resolveInterceptorAccess({
		type: 'approval',
		approval: 'NoResponse',
		origin: pendingInterceptorAccess.origin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
}

export async function resolveInterceptorAccess(confirmation: InterceptorAccessOptions) {
	if (pendingInterceptorAccess === undefined) return
	if (confirmation.origin !== pendingInterceptorAccess.origin || confirmation.requestAccessToAddress !== pendingInterceptorAccess.requestAccessToAddress) return

	const resolved = pendingInterceptorAccess
	pendingInterceptorAccess = undefined

	resolved.future.resolve(confirmation)
	if (confirmation.type === 'approval') { // close window on approval only, otherwise we want to keep the same window open
		if (openedInterceptorAccessWindow !== null && openedInterceptorAccessWindow.id) {
			browser.windows.onRemoved.removeListener(onCloseWindow)
			await browser.windows.remove(openedInterceptorAccessWindow.id)
		}
		openedInterceptorAccessWindow = null
	}
}

export function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray): AddressInfoEntry[] {
	if (window.interceptor.settings === undefined) return []
	const addresses = websiteAccess.map((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address)).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.userAddressBook.addressInfos
	return Array.from(addressSet).map((x) => findAddressInfo(x, infos))
}

export async function setPendingAccessRequests(pendingAccessRequest: PendingAccessRequestArray) {
	if (window.interceptor.settings === undefined) return
	window.interceptor.settings.pendingAccessRequests = pendingAccessRequest
	const addresses = window.interceptor.settings.pendingAccessRequests.map((x) => x.requestAccessToAddress === undefined ? [] : x.requestAccessToAddress).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.userAddressBook.addressInfos
	window.interceptor.pendingAccessMetadata = Array.from(addressSet).map((x) => [addressString(x), findAddressInfo(BigInt(x), infos)])
	savePendingAccessRequests(window.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(confirmation: InterceptorAccessOptions, origin: string, originIcon: string | undefined) {
	if (window.interceptor.settings === undefined) return
	if (confirmation.type !== 'approval') return
	if (confirmation.approval === 'NoResponse') return

	await setPendingAccessRequests(window.interceptor.settings.pendingAccessRequests.filter((x) => !(x.origin === origin && x.requestAccessToAddress === confirmation.requestAccessToAddress)))

	window.interceptor.settings.websiteAccess = setAccess(window.interceptor.settings.websiteAccess, origin, originIcon, confirmation.approval === 'Approved', confirmation.requestAccessToAddress)
	window.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(window.interceptor.settings.websiteAccess)
	saveWebsiteAccess(window.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

async function askForSignerAccountsFromSignerIfNotAvailable(port: browser.runtime.Port) {
	if (window.interceptor.signerAccounts !== undefined) return window.interceptor.signerAccounts
	const portSenderId = port.sender?.id
	if (portSenderId === undefined) return window.interceptor.signerAccounts

	const future = new Future<void>
	const listener = createInternalMessageListener( (message: WindowMessage) => {
		if (message.method === 'window_signer_accounts_changed' && message.data.portSenderId === portSenderId) return future.resolve()
	})
	try {
		window.addEventListener('message', listener)
		const messageSent = postMessageIfStillConnected(port, {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
		if (messageSent) await future
	} finally {
		window.removeEventListener('message', listener)
	}
	return window.interceptor.signerAccounts
}

type RequestAccessFromUserReply = {
	requestAccessToAddress: bigint | undefined
	approved: boolean
	userRequestedAddressChange: boolean,
}

export async function requestAccessFromUser(port: browser.runtime.Port | undefined, origin: string, icon: string | undefined, requestAccessToAddress: AddressInfoEntry | undefined, associatedAddresses: AddressInfoEntry[]): Promise<RequestAccessFromUserReply> {
	const rejectReply = { requestAccessToAddress: requestAccessToAddress?.address, approved: false, userRequestedAddressChange: false }
	if (window.interceptor.settings === undefined) return rejectReply

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && window.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address)?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined
	const simulationMode = window.interceptor.settings.simulationMode

	if (window.interceptor.settings.pendingAccessRequests.find((x) => x.origin === origin && x.requestAccessToAddress === accessAddress?.address) === undefined) {
		// we didn't have this request pending already, add it to the list
		await setPendingAccessRequests(window.interceptor.settings.pendingAccessRequests.concat({
			origin: origin,
			requestAccessToAddress: accessAddress?.address,
			icon: icon,
		}))
		sendPopupMessageToOpenWindows({ method: 'popup_notification_added' })
	}

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = PopupMessage.parse(msg)
		if (message.method !== 'popup_interceptorAccessReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		if (window.interceptor.settings === undefined) return rejectReply
		return await sendPopupMessageToOpenWindows({
			method: 'popup_interceptorAccessDialog',
			data: {
				title: 'TODO add title',
				origin: origin,
				icon: icon,
				requestAccessToAddress: accessAddress,
				associatedAddresses: associatedAddresses,
				addressInfos: window.interceptor.settings.userAddressBook.addressInfos,
				signerAccounts: [],
				signerName: window.interceptor.signerName,
				simulationMode: simulationMode,
				allowAddressChanging: port !== undefined,
			}
		})
	}

	if (pendingInterceptorAccess !== undefined) {
		if (pendingInterceptorAccess.origin === origin && pendingInterceptorAccess.requestAccessToAddress === requestAccessToAddress?.address) {
			return rejectReply // there's already one pending request, and it's different access request
		}
	} else {
		pendingInterceptorAccess = {
			future: new Future<InterceptorAccessOptions>(),
			origin: origin,
			requestAccessToAddress: accessAddress?.address,
		}
		browser.runtime.onMessage.addListener(windowReadyAndListening)

		openedInterceptorAccessWindow = await browser.windows.create(
			{
				url: '../html/interceptorAccess.html',
				type: 'popup',
				height: 600,
				width: 600,
			}
		)

		if (openedInterceptorAccessWindow) {
			browser.windows.onRemoved.addListener(onCloseWindow) // check if user has closed the window on their own, if so, reject signature
		} else {
			resolveInterceptorAccess({
				type: 'approval',
				approval: 'NoResponse',
				origin: pendingInterceptorAccess.origin,
				requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
			})
		}
	}

	while (true) {
		const confirmation = await pendingInterceptorAccess.future
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		if (confirmation.type === 'approval') {
			browser.windows.onRemoved.removeListener(onCloseWindow)
			const userRequestedAddressChange = confirmation.requestAccessToAddress !== requestAccessToAddress?.address

			if (userRequestedAddressChange) {
				// clear the original pending request, which was made with other account
				await setPendingAccessRequests(window.interceptor.settings.pendingAccessRequests.filter((x) => !(x.origin === origin && x.requestAccessToAddress === requestAccessToAddress?.address)))

				// change address
				await changeActiveAddressAndChainAndResetSimulation(confirmation.requestAccessToAddress, 'noActiveChainChange')
			}

			await changeAccess(confirmation, origin, icon)
			return {
				requestAccessToAddress: confirmation.requestAccessToAddress,
				approved: confirmation.approval === 'Approved',
				userRequestedAddressChange: userRequestedAddressChange, // if true, the access given was not for the original address
			}
		} else { // user requested address change
			if (requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
			if (port === undefined) throw new Error('Requesting account change on site that we cannot connect anymore')

			async function getProposedAddress(port: browser.runtime.Port, confirmation: InterceptorAccessOptions & { type: 'addressChange' | 'addressRefresh' }) {
				if (confirmation.type === 'addressRefresh' || confirmation.newActiveAddress === 'signer') {
					const signerAccounts = await askForSignerAccountsFromSignerIfNotAvailable(port)
					return signerAccounts === undefined || signerAccounts.length == 0 ? undefined : signerAccounts[0]
				}
				return confirmation.newActiveAddress
			}

			const proposedAddress = await getProposedAddress(port, confirmation)

			const newActiveAddress: bigint = proposedAddress === undefined ? requestAccessToAddress.address : proposedAddress
			const newActiveAddressAddressInfo = findAddressInfo(newActiveAddress, window.interceptor.settings.userAddressBook.addressInfos)
			const associatedAddresses = getAssociatedAddresses(window.interceptor.settings, origin, newActiveAddressAddressInfo)
			pendingInterceptorAccess = {
				future: new Future<InterceptorAccessOptions>(),
				origin: origin,
				requestAccessToAddress: newActiveAddress,
			}
			await sendPopupMessageToOpenWindows({
				method: 'popup_interceptorAccessDialog',
				data: {
					title: 'TODO add title',
					origin: origin,
					icon: icon,
					requestAccessToAddress: newActiveAddressAddressInfo,
					associatedAddresses: associatedAddresses,
					addressInfos: window.interceptor.settings.userAddressBook.addressInfos,
					signerAccounts: [],
					signerName: window.interceptor.signerName,
					simulationMode: simulationMode,
					allowAddressChanging: port !== undefined,
				}
			})
		}
	}
}

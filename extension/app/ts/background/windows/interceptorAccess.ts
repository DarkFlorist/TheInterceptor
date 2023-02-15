import { addressString } from '../../utils/bigint.js'
import { Future } from '../../utils/future.js'
import { PopupMessage } from '../../utils/interceptor-messages.js'
import { AddressInfoEntry, PendingAccessRequestArray } from '../../utils/user-interface-types.js'
import { setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { savePendingAccessRequests, saveWebsiteAccess, WebsiteAccessArray } from '../settings.js'

export type Confirmation = {
	outcome: 'Approved' | 'Rejected' | 'NoResponse',
	origin : string,
	requestAccessToAddress: bigint | undefined,
}

let openedInterceptorAccessWindow: browser.windows.Window | null = null

let pendingInterceptorAccess: {
	future: Future<Confirmation>
	origin: string,
	requestAccessToAddress: bigint | undefined,
} | undefined = undefined

const onCloseWindow = () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.future.resolve({
		outcome: 'NoResponse',
		origin: pendingInterceptorAccess.origin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
	pendingInterceptorAccess = undefined
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener( onCloseWindow )
}

export async function resolveExistingInterceptorAccessAsNoResponse() {
	if (pendingInterceptorAccess === undefined) return
	await resolveInterceptorAccess({
		outcome: 'NoResponse',
		origin: pendingInterceptorAccess.origin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
	})
}

export async function resolveInterceptorAccess(confirmation: Confirmation) {
	if (pendingInterceptorAccess === undefined) return
	if (confirmation.origin !== pendingInterceptorAccess.origin || confirmation.requestAccessToAddress !== pendingInterceptorAccess.requestAccessToAddress) return

	pendingInterceptorAccess.future.resolve(confirmation)
	pendingInterceptorAccess = undefined

	if (openedInterceptorAccessWindow !== null && openedInterceptorAccessWindow.id) {
		browser.windows.onRemoved.removeListener( onCloseWindow )
		await browser.windows.remove(openedInterceptorAccessWindow.id)
	}
	openedInterceptorAccessWindow = null
}

export function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray) : AddressInfoEntry[] {
	if ( window.interceptor.settings === undefined) return []
	const addresses = websiteAccess.map( (x) => x.addressAccess === undefined ? [] : x.addressAccess?.map( (addr) => addr.address) ).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.userAddressBook.addressInfos
	return Array.from(addressSet).map( (x) => findAddressInfo(x, infos) )
}

export async function setPendingAccessRequests(pendingAccessRequest: PendingAccessRequestArray) {
	if ( window.interceptor.settings === undefined ) return
	window.interceptor.settings.pendingAccessRequests = pendingAccessRequest
	const addresses = window.interceptor.settings.pendingAccessRequests.map( (x) => x.requestAccessToAddress === undefined ? [] : x.requestAccessToAddress ).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.userAddressBook.addressInfos
	window.interceptor.pendingAccessMetadata = Array.from(addressSet).map( (x) => [addressString(x), findAddressInfo(BigInt(x), infos)] )
	savePendingAccessRequests(window.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(confirmation: Confirmation, origin: string, originIcon: string | undefined, accessAddress: bigint | undefined) {
	if (window.interceptor.settings === undefined) return
	if (confirmation.outcome === 'NoResponse') return

	await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.filter((x) => !(x.origin === origin && x.requestAccessToAddress === accessAddress)))

	window.interceptor.settings.websiteAccess = setAccess(window.interceptor.settings.websiteAccess, origin, originIcon, confirmation.outcome === 'Approved', accessAddress)
	window.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(window.interceptor.settings.websiteAccess)
	saveWebsiteAccess(window.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function requestAccessFromUser(origin: string, icon: string | undefined, requestAccessToAddress: AddressInfoEntry | undefined, associatedAddresses: AddressInfoEntry[]) {
	if (window.interceptor.settings === undefined) return false

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && window.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === requestAccessToAddress.address )?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	if (window.interceptor.settings.pendingAccessRequests.find((x) => x.origin === origin && x.requestAccessToAddress === accessAddress?.address) === undefined) {
		// we didn't have this request pending already, add it to the list
		await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.concat( {
			origin: origin,
			requestAccessToAddress: accessAddress?.address,
			icon: icon,
		}) )
		sendPopupMessageToOpenWindows({ method: 'popup_notification_added' })
	}

	if (pendingInterceptorAccess !== undefined) {
		if ( pendingInterceptorAccess.origin === origin && pendingInterceptorAccess.requestAccessToAddress === requestAccessToAddress?.address ) {
			return false // there's already one pending request, and it's different access request
		}
	} else {
		pendingInterceptorAccess =  {
			future: new Future<Confirmation>(),
			origin: origin,
			requestAccessToAddress: accessAddress?.address,
		}

		const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
			const message = PopupMessage.parse(msg)
			if ( message.method !== 'popup_interceptorAccessReadyAndListening') return
			browser.runtime.onMessage.removeListener(windowReadyAndListening)
			return sendPopupMessageToOpenWindows({
				method: 'popup_interceptorAccessDialog',
				data: {
					origin: origin,
					icon: icon,
					requestAccessToAddress: accessAddress,
					associatedAddresses: associatedAddresses,
				}
			})
		}

		browser.runtime.onMessage.addListener(windowReadyAndListening)

		openedInterceptorAccessWindow = await browser.windows.create(
			{
				url: '../html/interceptorAccess.html',
				type: 'popup',
				height: 400,
				width: 520,
			}
		)

		if (openedInterceptorAccessWindow) {
			browser.windows.onRemoved.addListener( onCloseWindow ) // check if user has closed the window on their own, if so, reject signature
		} else {
			resolveInterceptorAccess({
				outcome: 'NoResponse',
				origin: pendingInterceptorAccess.origin,
				requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress
			})
		}
	}

	const confirmation = await pendingInterceptorAccess.future

	await changeAccess(confirmation, origin, icon, accessAddress ? accessAddress.address : undefined)

	return confirmation.outcome === 'Approved'
}

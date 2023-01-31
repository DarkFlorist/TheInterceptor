import { addressString } from '../../utils/bigint.js'
import { Future } from '../../utils/future.js'
import { imageToUri } from '../../utils/imageToUri.js'
import { PopupMessage } from '../../utils/interceptor-messages.js'
import { AddressInfoEntry, PendingAccessRequest } from '../../utils/user-interface-types.js'
import { setAccess, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { updateExtensionBadge } from '../iconHandler.js'
import { findAddressInfo } from '../metadataUtils.js'
import { savePendingAccessRequests, saveWebsiteAccess, WebsiteAccess } from '../settings.js'

export type Confirmation = {
	outcome: 'Approved' | 'Rejected' | 'NoResponse',
	origin : string,
	requestAccessToAddress: string | undefined,
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
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress === undefined ? undefined : addressString(pendingInterceptorAccess.requestAccessToAddress)
	})
	pendingInterceptorAccess = undefined
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener( onCloseWindow )
}

export async function resolveExistingInterceptorAccessAsNoResponse() {
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.future.resolve({
		outcome: 'NoResponse',
		origin: pendingInterceptorAccess.origin,
		requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress === undefined ? undefined : addressString(pendingInterceptorAccess.requestAccessToAddress)
	})
}

export async function resolveInterceptorAccess(confirmation: Confirmation) {
	if (pendingInterceptorAccess !== undefined)
	pendingInterceptorAccess.future.resolve(confirmation)
	pendingInterceptorAccess = undefined

	if (openedInterceptorAccessWindow !== null && openedInterceptorAccessWindow.id) {
		browser.windows.onRemoved.removeListener( onCloseWindow )
		await browser.windows.remove(openedInterceptorAccessWindow.id)
	}
	openedInterceptorAccessWindow = null
}

export function getAddressMetadataForAccess(websiteAccess: readonly WebsiteAccess[]) : [string, AddressInfoEntry][]{
	if ( window.interceptor.settings === undefined) return []
	const addresses = websiteAccess.map( (x) => x.addressAccess === undefined ? [] : x.addressAccess?.map( (addr) => addr.address) ).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.addressInfos
	return Array.from(addressSet).map( (x) => [x, findAddressInfo(BigInt(x), infos)] )
}

export async function retrieveIcon(tabId: number | undefined) {
	if ( tabId === undefined) return undefined

	// wait for the tab to be fully loaded
	const waitForLoaded = new Promise(async resolve => {
		const listener = function listener(tabIdUpdated: number, info: browser.tabs._OnUpdatedChangeInfo) {
			if (info.status === 'complete' && tabId === tabIdUpdated) {
				browser.tabs.onUpdated.removeListener(listener)
				resolve(undefined)
			}
		}
		browser.tabs.onUpdated.addListener(listener)
		if( (await browser.tabs.get(tabId)).status === 'complete') {
			browser.tabs.onUpdated.removeListener(listener)
			resolve(undefined)
		}
	})

	await waitForLoaded

	// if the tab is not ready yet try to wait for a while for it to be ready, if not, we just have no icon to show on firefox
	let maxRetries = 10
	// apparently there's a lot bugs in firefox related to getting this favicon. Eve if the tab has loaded, the favicon is not necessary loaded either
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1450384
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1417721
	// below is my attempt to try to get favicon...
	while ( (await browser.tabs.get(tabId)).favIconUrl === undefined) {
		await new Promise(resolve => setTimeout(resolve, 100))
		maxRetries--
		if (maxRetries <= 0) break // timeout
	}
	const url = (await browser.tabs.get(tabId)).favIconUrl
	return url === undefined ? undefined : await imageToUri(url)
}

export async function setPendingAccessRequests(pendingAccessRequest: readonly PendingAccessRequest[]) {
	if ( window.interceptor.settings === undefined ) return
	window.interceptor.settings.pendingAccessRequests = pendingAccessRequest
	const addresses = window.interceptor.settings.pendingAccessRequests.map( (x) => x.requestAccessToAddress === undefined ? [] : x.requestAccessToAddress ).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.addressInfos
	window.interceptor.pendingAccessMetadata = Array.from(addressSet).map( (x) => [x, findAddressInfo(BigInt(x), infos)] )
	savePendingAccessRequests(window.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(confirmation: Confirmation, origin: string, originIcon: string | undefined, accessAddress: string | undefined) {
	if (window.interceptor.settings === undefined) return
	if (confirmation.outcome === 'NoResponse') return

	await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.filter( (x) => !(x.origin === origin && x.requestAccessToAddress === accessAddress) ) )

	window.interceptor.settings.websiteAccess = setAccess(window.interceptor.settings.websiteAccess, origin, originIcon, confirmation.outcome === 'Approved', accessAddress)
	window.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(window.interceptor.settings.websiteAccess)
	saveWebsiteAccess(window.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows({ message: 'popup_websiteAccess_changed' })
}

export async function requestAccessFromUser(origin: string, icon: string | undefined, requestAccessToAddress: AddressInfoEntry | undefined, associatedAddresses: AddressInfoEntry[]) {
	if (window.interceptor.settings === undefined) return false

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && window.interceptor.settings?.addressInfos.find((x) => x.address === requestAccessToAddress.address )?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	if (window.interceptor.settings.pendingAccessRequests.find( (x) => x.origin === origin && x.requestAccessToAddress === accessAddress) === undefined) {
		// we didn't have this request pending already, add it to the list
		await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.concat( {
			origin: origin,
			requestAccessToAddress: accessAddress ? addressString(accessAddress.address) : undefined,
			icon: icon,
		}) )
		sendPopupMessageToOpenWindows({ message: 'popup_notification_added' })
	}

	if (pendingInterceptorAccess !== undefined) {
		if ( pendingInterceptorAccess.origin === origin && pendingInterceptorAccess.requestAccessToAddress === requestAccessToAddress ) {
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
				message: 'popup_interceptorAccessDialog',
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
				requestAccessToAddress: pendingInterceptorAccess.requestAccessToAddress === undefined ? undefined : addressString(pendingInterceptorAccess.requestAccessToAddress)
			})
		}
	}

	const confirmation = await pendingInterceptorAccess.future

	await changeAccess(confirmation, origin, icon, accessAddress ? addressString(accessAddress.address) : undefined)

	return confirmation.outcome === 'Approved'
}

import { addressString } from '../../utils/bigint'
import { Future } from '../../utils/future'
import { imageToUri } from '../../utils/imageToUri'
import { PendingAccessRequest } from '../../utils/user-interface-types'
import { AddressMetadata } from '../../utils/visualizer-types'
import { setAccess, updateWebsiteApprovalAccesses } from '../accessManagement'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils'
import { updateExtensionBadge } from '../iconHandler'
import { getAddressMetaData } from '../metadataUtils'
import { savePendingAccessRequests, saveWebsiteAccess, WebsiteAccess } from '../settings'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let pendingInterceptorAccess: Future<Confirmation> | undefined = undefined

let openedInterceptorAccessWindow: browser.windows.Window | null = null

const onCloseWindow = () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.resolve('NoResponse')
	pendingInterceptorAccess = undefined
	window.interceptor.interceptorAccessDialog = undefined
	openedInterceptorAccessWindow = null
	browser.windows.onRemoved.removeListener( onCloseWindow )
}

export async function resolveInterceptorAccess(confirmation: Confirmation) {
	if (pendingInterceptorAccess !== undefined) pendingInterceptorAccess.resolve(confirmation)
	pendingInterceptorAccess = undefined

	if (openedInterceptorAccessWindow !== null && openedInterceptorAccessWindow.id) {
		browser.windows.onRemoved.removeListener( onCloseWindow )
		await browser.windows.remove(openedInterceptorAccessWindow.id)
	}
	window.interceptor.interceptorAccessDialog = undefined
	openedInterceptorAccessWindow = null
}

export function getAddressMetadataForAccess(websiteAccess: readonly WebsiteAccess[]) : [string, AddressMetadata][]{
	if ( window.interceptor.settings === undefined) return []
	const addresses = websiteAccess.map( (x) => x.addressAccess === undefined ? [] : x.addressAccess?.map( (addr) => addr.address) ).flat()
	const addressSet = new Set(addresses)
	const infos = window.interceptor.settings.addressInfos
	return Array.from(addressSet).map( (x) => [x, getAddressMetaData(BigInt(x), infos)] )
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
	window.interceptor.pendingAccessMetadata = Array.from(addressSet).map( (x) => [x, getAddressMetaData(BigInt(x), infos)] )
	savePendingAccessRequests(window.interceptor.settings.pendingAccessRequests)
	await updateExtensionBadge()
}

export async function changeAccess(access: Confirmation, origin: string, originIcon: string | undefined, accessAddress: string | undefined) {
	if (window.interceptor.settings === undefined) return
	if (access === 'NoResponse') return

	await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.filter( (x) => !(x.origin === origin && x.requestAccessToAddress === accessAddress) ) )

	window.interceptor.settings.websiteAccess = setAccess(window.interceptor.settings.websiteAccess, origin, originIcon, access === 'Approved', accessAddress)
	window.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(window.interceptor.settings.websiteAccess)
	saveWebsiteAccess(window.interceptor.settings.websiteAccess)
	updateWebsiteApprovalAccesses()
	sendPopupMessageToOpenWindows('popup_websiteAccess_changed')
}

export async function requestAccessFromUser(origin: string, icon: string | undefined, requestAccessToAddress: string | undefined = undefined, addressMetadata: [string, AddressMetadata][] = []) {
	if (window.interceptor.settings === undefined) return false

	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && window.interceptor.settings?.addressInfos.find((x) => addressString(x.address) === requestAccessToAddress )?.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined

	if (window.interceptor.settings.pendingAccessRequests.find( (x) => x.origin === origin && x.requestAccessToAddress === accessAddress) === undefined) {
		// we didn't have this request pending already, add it to the list
		await setPendingAccessRequests( window.interceptor.settings.pendingAccessRequests.concat( {
			origin: origin,
			requestAccessToAddress: accessAddress,
			icon: icon,
		}) )
		sendPopupMessageToOpenWindows('popup_notification_added')
	}

	if (pendingInterceptorAccess !== undefined) {
		return false // instead of popping new dialogs, block until the old one closes
	}

	pendingInterceptorAccess = new Future<Confirmation>()

	window.interceptor.interceptorAccessDialog =  {
		origin: origin,
		icon: icon,
		requestAccessToAddress: accessAddress,
		addressMetadata: addressMetadata,
	}

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
		resolveInterceptorAccess('NoResponse')
	}

	const access = await pendingInterceptorAccess

	await changeAccess(access, origin, icon, accessAddress)

	return access === 'Approved'
}

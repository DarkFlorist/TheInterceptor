import { getSignerName } from '../components/subcomponents/signers.js'
import { ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, isSupportedChain } from '../utils/constants.js'
import { getActiveAddressForDomain, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeText, setExtensionIcon } from './backgroundUtils.js'
import { getAddressMetaData } from './metadataUtils.js'
import { imageToUri } from '../utils/imageToUri.js'
import { Future } from '../utils/future.js'
import { WebsiteSocket } from '../utils/interceptor-messages.js'

async function setInterceptorIcon(tabId: number, icon: string, iconReason: string) {
	const previousValue = globalThis.interceptor.websiteTabConnection.get(tabId)
	globalThis.interceptor.websiteTabConnection.set(tabId, {
		portConnections: previousValue === undefined ? {} : previousValue.portConnections,
		tabIconDetails: {
			icon: icon,
			iconReason: iconReason
		}
	})
	sendPopupMessageToOpenWindows({ method: 'popup_websiteIconChanged' })
	return await setExtensionIcon({
		path: { 128: icon },
		tabId: tabId
	})
}

export function updateExtensionIcon(socket: WebsiteSocket, websiteOrigin: string) {
	if (!globalThis.interceptor.settings) return
	const activeAddress = getActiveAddress()
	const censoredActiveAddress = getActiveAddressForDomain(globalThis.interceptor.settings.websiteAccess, websiteOrigin)
	if (activeAddress === undefined) return setInterceptorIcon(socket.tabId, ICON_NOT_ACTIVE, 'No active address selected.')
	if (hasAddressAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin, activeAddress )  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setInterceptorIcon(socket.tabId, ICON_NOT_ACTIVE, `${ websiteOrigin } has PENDING access request for ${ getAddressMetaData(activeAddress, globalThis.interceptor.settings?.userAddressBook).name }!`)
	}

	if (censoredActiveAddress === undefined) {
		if ( hasAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin) === 'noAccess') {
			return setInterceptorIcon(socket.tabId, ICON_ACCESS_DENIED, `The access for ${ websiteOrigin } has been DENIED!`)
		}
		return setInterceptorIcon(socket.tabId, ICON_ACCESS_DENIED, `The access to ${ getAddressMetaData(activeAddress, globalThis.interceptor.settings?.userAddressBook).name } for ${ websiteOrigin } has been DENIED!`)
	}
	if (globalThis.interceptor.settings?.simulationMode) return setInterceptorIcon(socket.tabId, ICON_SIMULATING, `The Interceptor simulates your sent transactions.`)
	if (!isSupportedChain(globalThis.interceptor.settings.activeChain.toString())) return setInterceptorIcon(socket.tabId, ICON_SIGNING_NOT_SUPPORTED, `Interceptor is on an unsupported network and simulation mode is disabled.`)

	return setInterceptorIcon(socket.tabId, ICON_SIGNING, `The Interceptor forwards your transactions to ${ getSignerName(globalThis.interceptor.signerName) } once sent.`)
}

export async function updateExtensionBadge() {
	if (!globalThis.interceptor.settings) return
	const count = globalThis.interceptor.settings.pendingAccessRequests.length
	return await setExtensionBadgeText( { text: count === 0 ? '' : count.toString() } )
}

export async function retrieveWebsiteDetails(port: browser.runtime.Port, websiteOrigin: string) {
	const tabId = port.sender?.tab?.id
	if (tabId === undefined) return  {
		websiteOrigin: websiteOrigin,
		title: undefined,
		icon: undefined
	}

	// wait for the tab to be fully loaded
	const waitForLoadedFuture = new Future<void>
	const waitForLoaded = async () => {
		try {
			const listener = function listener(tabIdUpdated: number, info: browser.tabs._OnUpdatedChangeInfo) {
				if (info.status === 'complete' && tabId === tabIdUpdated) {
					browser.tabs.onUpdated.removeListener(listener)
					return waitForLoadedFuture.resolve()
				}
			}
			browser.tabs.onUpdated.addListener(listener)
			if( (await browser.tabs.get(tabId)).status === 'complete') {
				browser.tabs.onUpdated.removeListener(listener)
				return waitForLoadedFuture.resolve()
			}
			return waitForLoadedFuture.resolve()
		} catch(error) {
			if (error instanceof Error) return waitForLoadedFuture.reject(error)
			return waitForLoadedFuture.reject(new Error('Unknown error'))
		}
	}

	waitForLoaded()
	await waitForLoadedFuture
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
	const tab = await browser.tabs.get(tabId)
	return {
		websiteOrigin: websiteOrigin,
		title: tab.title,
		icon: tab.favIconUrl === undefined ? undefined : await imageToUri(tab.favIconUrl)
	}
}

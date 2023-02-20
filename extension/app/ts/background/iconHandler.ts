import { getSignerName } from '../components/subcomponents/signers.js'
import { ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, isSupportedChain } from '../utils/constants.js'
import { getActiveAddressForDomain, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getAddressMetaData } from './metadataUtils.js'
import { imageToUri } from '../utils/imageToUri.js'
import { Future } from '../utils/future.js'

function setInterceptorIcon(tabId: number, icon: string, iconReason: string) {
	window.interceptor.websiteTabConnection.set(tabId, {
		icon: icon,
		iconReason: iconReason
	})
	sendPopupMessageToOpenWindows({ method: 'popup_websiteIconChanged' })
	return browser.browserAction.setIcon({
		path: { 128: icon },
		tabId: tabId
	})
}

export function updateExtensionIcon(port: browser.runtime.Port) {
	if (!window.interceptor.settings) return
	if (port.sender?.tab?.id === undefined) return
	if (port.sender?.url === undefined) return

	const origin = (new URL(port.sender.url)).hostname
	const activeAddress = getActiveAddress()
	const censoredActiveAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, origin)
	if ( activeAddress === undefined) return setInterceptorIcon(port.sender.tab.id, ICON_NOT_ACTIVE, 'No active address selected.')
	if (hasAddressAccess(window.interceptor.settings.websiteAccess, origin, activeAddress )  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setInterceptorIcon(port.sender.tab.id, ICON_NOT_ACTIVE, `${ origin } has PENDING access request for ${ getAddressMetaData(activeAddress, window.interceptor.settings?.userAddressBook).name }!`)
	}

	if (censoredActiveAddress === undefined) {
		if ( hasAccess(window.interceptor.settings.websiteAccess, origin) === 'noAccess') {
			return setInterceptorIcon(port.sender.tab.id, ICON_ACCESS_DENIED, `The access for ${ origin } has been DENIED!`)
		}
		return setInterceptorIcon(port.sender.tab.id, ICON_ACCESS_DENIED, `The access to ${ getAddressMetaData(activeAddress, window.interceptor.settings?.userAddressBook).name } for ${ origin } has been DENIED!`)
	}
	if (window.interceptor.settings?.simulationMode) return setInterceptorIcon(port.sender.tab.id, ICON_SIMULATING, `The Interceptor simulates your sent transactions.`)
	if (!isSupportedChain(window.interceptor.settings.activeChain.toString())) return setInterceptorIcon(port.sender.tab.id, ICON_SIGNING_NOT_SUPPORTED, `Interceptor is on an unsupported network and simulation mode is disabled.`)

	return setInterceptorIcon(port.sender.tab.id, ICON_SIGNING, `The Interceptor forwards your transactions to ${ getSignerName(window.interceptor.signerName) } once sent.`)
}

export async function updateExtensionBadge() {
	if (!window.interceptor.settings) return
	const count = window.interceptor.settings.pendingAccessRequests.length
	return await browser.browserAction.setBadgeText( { text: count === 0 ? '' : count.toString() } )
}

export async function retrieveWebsiteTabIcon(tabId: number | undefined) {
	if ( tabId === undefined) return undefined

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
	const url = (await browser.tabs.get(tabId)).favIconUrl
	return url === undefined ? undefined : await imageToUri(url)
}

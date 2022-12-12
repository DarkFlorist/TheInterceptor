import { addressString } from '../utils/bigint.js'
import { ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, isSupportedChain } from '../utils/constants.js'
import { getActiveAddressForDomain, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'

function setIcon(tabId: number, icon: string) {
	window.interceptor.websiteTabIcons.set(tabId, icon )
	sendPopupMessageToOpenWindows('popup_websiteIconChanged');
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
	if ( activeAddress === undefined || hasAddressAccess(window.interceptor.settings.websiteAccess, origin, addressString(activeAddress) )  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setIcon(port.sender.tab.id, ICON_NOT_ACTIVE)
	}

	if (censoredActiveAddress === undefined) return setIcon(port.sender.tab.id, ICON_ACCESS_DENIED)
	if (window.interceptor.settings?.simulationMode) return setIcon(port.sender.tab.id, ICON_SIMULATING)
	if (!isSupportedChain(window.interceptor.settings.activeChain.toString())) return setIcon(port.sender.tab.id, ICON_SIGNING_NOT_SUPPORTED)

	return setIcon(port.sender.tab.id, ICON_SIGNING)
}

export async function updateExtensionBadge() {
	if (!window.interceptor.settings) return
	const count = window.interceptor.settings.pendingAccessRequests.length
	return await browser.browserAction.setBadgeText( { text: count === 0 ? '' : count.toString() } )
}

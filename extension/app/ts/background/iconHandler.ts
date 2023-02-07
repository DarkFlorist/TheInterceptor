import { getSignerName } from '../components/subcomponents/signers.js'
import { ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, isSupportedChain } from '../utils/constants.js'
import { getActiveAddressForDomain, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getAddressMetaData } from './metadataUtils.js'

function setIcon(tabId: number, icon: string, iconReason: string) {
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
	if ( activeAddress === undefined) return setIcon(port.sender.tab.id, ICON_NOT_ACTIVE, 'No active address selected.')
	if (hasAddressAccess(window.interceptor.settings.websiteAccess, origin, activeAddress )  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setIcon(port.sender.tab.id, ICON_NOT_ACTIVE, `${ origin } has PENDING access request for ${ getAddressMetaData(activeAddress, window.interceptor.settings?.addressInfos).name }!`)
	}

	if (censoredActiveAddress === undefined) {
		if ( hasAccess(window.interceptor.settings.websiteAccess, origin) === 'noAccess') {
			return setIcon(port.sender.tab.id, ICON_ACCESS_DENIED, `The access for ${ origin } has been DENIED!`)
		}
		return setIcon(port.sender.tab.id, ICON_ACCESS_DENIED, `The access to ${ getAddressMetaData(activeAddress, window.interceptor.settings?.addressInfos).name } for ${ origin } has been DENIED!`)
	}
	if (window.interceptor.settings?.simulationMode) return setIcon(port.sender.tab.id, ICON_SIMULATING, `The Interceptor simulates your sent transactions.`)
	if (!isSupportedChain(window.interceptor.settings.activeChain.toString())) return setIcon(port.sender.tab.id, ICON_SIGNING_NOT_SUPPORTED, `Interceptor is on an unsupported network and simulation mode is disabled.`)

	return setIcon(port.sender.tab.id, ICON_SIGNING, `The Interceptor forwards your transactions to ${ getSignerName(window.interceptor.signerName) } once sent.`)
}

export async function updateExtensionBadge() {
	if (!window.interceptor.settings) return
	const count = window.interceptor.settings.pendingAccessRequests.length
	return await browser.browserAction.setBadgeText( { text: count === 0 ? '' : count.toString() } )
}

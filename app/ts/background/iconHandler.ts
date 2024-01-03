import { getPrettySignerName } from '../components/subcomponents/signers.js'
import { CHROME_NO_TAB_WITH_ID_ERROR, ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, PRIMARY_COLOR, WARNING_COLOR } from '../utils/constants.js'
import { hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionBadgeText, setExtensionIcon } from './backgroundUtils.js'
import { imageToUri } from '../utils/imageToUri.js'
import { Future } from '../utils/future.js'
import { RpcConnectionStatus, TabIcon, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSettings } from './settings.js'
import { getRpcConnectionStatus, getTabState, updateTabState } from './storageVariables.js'
import { getLastKnownCurrentTabId } from './popupMessageHandlers.js'
import { WebsiteSocket } from '../utils/requests.js'

async function setInterceptorIcon(websiteTabConnections: WebsiteTabConnections, tabId: number, icon: TabIcon, iconReason: string) {
	const previousValue = websiteTabConnections.get(tabId)
	if (previousValue === undefined) return

	const tabIconDetails = {
		icon: icon,
		iconReason: iconReason
	}

	await updateTabState(tabId, (previousState: TabState) => ({ ...previousState, tabIconDetails }))

	if (await getLastKnownCurrentTabId() === tabId) {
		await sendPopupMessageToOpenWindows({
			method: 'popup_websiteIconChanged',
			data: tabIconDetails
		})
	}

	return await setExtensionIcon({
		path: { 128: icon },
		tabId: tabId
	})
}

export async function updateExtensionIcon(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const settings = await getSettings()
	const activeAddress = await getActiveAddress(settings, socket.tabId)
	if (activeAddress === undefined) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_NOT_ACTIVE, 'No active address selected.')
	if (hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress)  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_NOT_ACTIVE, `${ websiteOrigin } has PENDING access request for ${ activeAddress.name }!`)
	}

	const addressAccess = hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress)
	if (addressAccess !== 'hasAccess') {
		if (hasAccess(settings.websiteAccess, websiteOrigin) === 'noAccess') {
			return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_ACCESS_DENIED, `The access for ${ websiteOrigin } has been DENIED!`)
		}
		return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_ACCESS_DENIED, `The access to ${ activeAddress.name } for ${ websiteOrigin } has been DENIED!`)
	}
	if (settings.simulationMode) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIMULATING, `The Interceptor simulates your sent transactions.`)
	if (settings.rpcNetwork.httpsRpc === undefined) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIGNING_NOT_SUPPORTED, `Interceptor is on an unsupported network and simulation mode is disabled.`)
	const tabState = await getTabState(socket.tabId)
	return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIGNING, `The Interceptor forwards your transactions to ${ getPrettySignerName(tabState.signerName) } once sent.`)
}

export function noNewBlockForOverTwoMins(connectionStatus: RpcConnectionStatus) {
	return connectionStatus && connectionStatus.latestBlock && (connectionStatus.lastConnnectionAttempt.getTime() - connectionStatus.latestBlock.timestamp.getTime()) > 2 * 60 * 1000
}

export async function updateExtensionBadge() {
	const connectionStatus = await getRpcConnectionStatus()
	if (connectionStatus?.isConnected === false || noNewBlockForOverTwoMins(connectionStatus)) {
		await setExtensionBadgeBackgroundColor({ color: WARNING_COLOR })
		return await setExtensionBadgeText({ text: '!' })
	}
	await setExtensionBadgeBackgroundColor({ color: PRIMARY_COLOR })
	return await setExtensionBadgeText( { text: '' } )
}

export async function retrieveWebsiteDetails(port: browser.runtime.Port, websiteOrigin: string) {
	const tryGettingTab = async (tabId: number) => {
		try {
			return await browser.tabs.get(tabId)
		} catch (error) {
			if (!(error instanceof Error)) throw error
			if (!error.message?.includes(CHROME_NO_TAB_WITH_ID_ERROR)) throw error
			// if tab is not found (user might have closed it)
			return undefined
		}
	}

	const tabId = port.sender?.tab?.id
	if (tabId === undefined) return  {
		websiteOrigin: websiteOrigin,
		title: undefined,
		icon: undefined
	}

	// wait for the tab to be fully loaded
	const listener = function listener(tabIdUpdated: number, info: browser.tabs._OnUpdatedChangeInfo) {
		if (info.status === 'complete' && tabId === tabIdUpdated) {
			return waitForLoadedFuture.resolve()
		}
	}

	const waitForLoadedFuture = new Future<void>
	try {
		browser.tabs.onUpdated.addListener(listener)
		const tab = await tryGettingTab(tabId)
		if (tab !== undefined && tab.status === 'complete') {
			waitForLoadedFuture.resolve()
		}
		await waitForLoadedFuture
	} catch(error) {
		if (error instanceof Error) {
			waitForLoadedFuture.reject(error)
		} else {
			waitForLoadedFuture.reject(new Error('Unknown error'))
		}
	} finally {
		browser.tabs.onUpdated.removeListener(listener)
	}

	// if the tab is not ready yet try to wait for a while for it to be ready, if not, we just have no icon to show on firefox
	let maxRetries = 10
	// apparently there's a lot bugs in firefox related to getting this favicon. Eve if the tab has loaded, the favicon is not necessary loaded either
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1450384
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1417721
	// below is my attempt to try to get favicon...
	while ((await tryGettingTab(tabId))?.favIconUrl === undefined) {
		await new Promise(resolve => setTimeout(resolve, 100))
		maxRetries--
		if (maxRetries <= 0) break // timeout
	}
	const tab = await tryGettingTab(tabId)
	return {
		websiteOrigin: websiteOrigin,
		title: tab?.title,
		icon: tab?.favIconUrl === undefined ? undefined : await imageToUri(tab.favIconUrl)
	}
}

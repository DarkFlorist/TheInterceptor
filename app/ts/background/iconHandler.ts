import { getPrettySignerName } from '../components/subcomponents/signers.js'
import { CHROME_NO_TAB_WITH_ID_ERROR, ICON_ACCESS_DENIED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, isSupportedChain, PRIMARY_COLOR, WARNING_COLOR } from '../utils/constants.js'
import { getActiveAddressForDomain, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionBadgeText, setExtensionIcon } from './backgroundUtils.js'
import { getAddressMetaData } from './metadataUtils.js'
import { imageToUri } from '../utils/imageToUri.js'
import { Future } from '../utils/future.js'
import { WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { getIsConnected, getSettings, getSignerName, updateTabState } from './settings.js'
import { TabIcon, TabState } from '../utils/interceptor-messages.js'
import { getLastKnownCurrentTabId } from './popupMessageHandlers.js'

async function setInterceptorIcon(websiteTabConnections: WebsiteTabConnections, tabId: number, icon: TabIcon, iconReason: string) {
	const previousValue = websiteTabConnections.get(tabId)
	if (previousValue === undefined) return

	const tabIconDetails = {
		icon: icon,
		iconReason: iconReason
	}

	await updateTabState(tabId, (previousState: TabState) => {
		return {
			...previousState,
			tabIconDetails
		}
	})

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
	const activeAddress = getActiveAddress(settings)
	const censoredActiveAddress = getActiveAddressForDomain(settings.websiteAccess, websiteOrigin, settings)
	if (activeAddress === undefined) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_NOT_ACTIVE, 'No active address selected.')
	if (hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress, settings)  === 'notFound') {
		// we don't have active address selected, or no access specified
		return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_NOT_ACTIVE, `${ websiteOrigin } has PENDING access request for ${ getAddressMetaData(activeAddress, settings.userAddressBook).name }!`)
	}

	if (censoredActiveAddress === undefined) {
		if (hasAccess(settings.websiteAccess, websiteOrigin) === 'noAccess') {
			return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_ACCESS_DENIED, `The access for ${ websiteOrigin } has been DENIED!`)
		}
		return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_ACCESS_DENIED, `The access to ${ getAddressMetaData(activeAddress, settings.userAddressBook).name } for ${ websiteOrigin } has been DENIED!`)
	}
	if (settings.simulationMode) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIMULATING, `The Interceptor simulates your sent transactions.`)
	if (!isSupportedChain(settings.activeChain.toString())) return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIGNING_NOT_SUPPORTED, `Interceptor is on an unsupported network and simulation mode is disabled.`)

	return setInterceptorIcon(websiteTabConnections, socket.tabId, ICON_SIGNING, `The Interceptor forwards your transactions to ${ getPrettySignerName(await getSignerName()) } once sent.`)
}

export async function updateExtensionBadge() {
	if ((await getIsConnected())?.isConnected === false) {
		await setExtensionBadgeBackgroundColor({ color: WARNING_COLOR })
		return await setExtensionBadgeText({ text: '!' })
	}
	const count = (await getSettings()).pendingAccessRequests.length
	await setExtensionBadgeBackgroundColor({ color: PRIMARY_COLOR })
	return await setExtensionBadgeText( { text: count === 0 ? '' : count.toString() } )
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

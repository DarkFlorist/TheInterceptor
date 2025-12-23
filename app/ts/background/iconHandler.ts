import { getPrettySignerName } from '../components/subcomponents/signers.js'
import { ICON_ACCESS_DENIED, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, PRIMARY_COLOR, TIME_BETWEEN_BLOCKS, WARNING_COLOR } from '../utils/constants.js'
import { areWeBlocking, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionBadgeText, setExtensionIcon, setExtensionTitle } from './backgroundUtils.js'
import { imageToUri } from '../utils/imageToUri.js'
import { Future } from '../utils/future.js'
import { RpcConnectionStatus, TabIcon, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSettings } from './settings.js'
import { getRpcConnectionStatus, getTabState, removeTabState, updateTabState } from './storageVariables.js'
import { getLastKnownCurrentTabId } from './popupMessageHandlers.js'
import { checkAndPrintRuntimeLastError, doesTabExist, safeGetTab } from '../utils/requests.js'
import { modifyObject } from '../utils/typescript.js'

async function setInterceptorIcon(tabId: number, icon: TabIcon, iconReason: string) {
	const tabIconDetails = { icon, iconReason }
	if (!(await doesTabExist(tabId))) return
	await updateTabState(tabId, (previousState: TabState) => modifyObject(previousState, { tabIconDetails }))
	if (await getLastKnownCurrentTabId() === tabId) await sendPopupMessageToOpenWindows({ method: 'popup_websiteIconChanged', data: tabIconDetails })
	try {
		await setExtensionIcon({ path: { 128: icon }, tabId })
		await setExtensionTitle({ title: iconReason, tabId })
	} catch (error) {
		console.warn('failed to set interceptor icon and reason')
		console.warn(error)
	}
}

export async function updateExtensionIcon(websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) {
	if (!(await doesTabExist(tabId))) {
		await removeTabState(tabId)
		return
	}
	const blockingWebsitePromise = areWeBlocking(websiteTabConnections, tabId, websiteOrigin)
	const addShieldIfNeeded = async (icon: TabIcon): Promise<TabIcon> => await blockingWebsitePromise && icon !== ICON_INTERCEPTOR_DISABLED ? TabIcon.parse(icon.replace('.png', '-shield.png')) : icon
	const setIcon = async (icon: TabIcon, iconReason: string) => setInterceptorIcon(tabId, await addShieldIfNeeded(icon), await blockingWebsitePromise ? `${ iconReason } The Interceptor is blocking external requests made by the website.` : iconReason)

	const settings = await getSettings()
	if (hasAccess(settings.websiteAccess, websiteOrigin) === 'interceptorDisabled') return setIcon(ICON_INTERCEPTOR_DISABLED, `The Interceptor is disabled for ${ websiteOrigin } by user request.`)
	const activeAddress = await getActiveAddress(settings, tabId)
	if (activeAddress === undefined) return setIcon(ICON_NOT_ACTIVE, 'No active address selected.')
	const addressAccess = hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress)
	if (addressAccess === 'notFound') return setIcon(ICON_NOT_ACTIVE, `${ websiteOrigin } has PENDING access request for ${ activeAddress.name }!`)
	if (addressAccess !== 'hasAccess') {
		if (hasAccess(settings.websiteAccess, websiteOrigin) === 'noAccess') {
			return setIcon(ICON_ACCESS_DENIED, `The access for ${ websiteOrigin } has been DENIED!`)
		}
		return setIcon(ICON_ACCESS_DENIED, `The access to ${ activeAddress.name } for ${ websiteOrigin } has been DENIED!`)
	}
	if (settings.simulationMode) return setIcon(ICON_SIMULATING, 'The Interceptor simulates your sent transactions.')
	if (settings.activeRpcNetwork.httpsRpc === undefined) return setIcon(ICON_SIGNING_NOT_SUPPORTED, `The Interceptor is disabled while it's on an unsupported network`)
	const tabState = await getTabState(tabId)
	return setIcon(ICON_SIGNING, `The Interceptor forwards your transactions to ${ getPrettySignerName(tabState.signerName) } once sent.`)
}

export function noNewBlockForOverTwoMins(connectionStatus: RpcConnectionStatus) {
	return connectionStatus?.latestBlock && (connectionStatus.lastConnnectionAttempt.getTime() - connectionStatus.latestBlock.timestamp.getTime()) > 2 * 60 * 1000
}

export async function updateExtensionBadge() {
	const connectionStatus = await getRpcConnectionStatus()
	if (connectionStatus?.isConnected === false || noNewBlockForOverTwoMins(connectionStatus) && connectionStatus && connectionStatus.retrying) {
		const nextConnectionAttempt = new Date(connectionStatus.lastConnnectionAttempt.getTime() + TIME_BETWEEN_BLOCKS * 1000)
		if (nextConnectionAttempt.getTime() - new Date().getTime() > 0) {
			await setExtensionBadgeBackgroundColor({ color: WARNING_COLOR })
			return await setExtensionBadgeText({ text: '!' })
		}
	}
	await setExtensionBadgeBackgroundColor({ color: PRIMARY_COLOR })
	return await setExtensionBadgeText( { text: '' } )
}

export async function retrieveWebsiteDetails(tabId: number) {
	const waitForLoadedFuture = new Future<void>

	// wait for the tab to be fully loaded
	const listener = function listener(tabIdUpdated: number, info: browser.tabs._OnUpdatedChangeInfo) {
		try {
			if (info.status === 'complete' && tabId === tabIdUpdated) return waitForLoadedFuture.resolve()
		} finally {
			checkAndPrintRuntimeLastError()
		}
	}

	try {
		browser.tabs.onUpdated.addListener(listener)
		const tab = await safeGetTab(tabId)
		if (tab !== undefined && tab.status === 'complete') waitForLoadedFuture.resolve()
		let timeout = undefined
		try {
			timeout = setTimeout(() => waitForLoadedFuture.reject(new Error('timed out')), 60000)
			await waitForLoadedFuture
		} finally {
			clearTimeout(timeout)
		}
	} catch(error) {
		return { title: undefined, icon: undefined }
	} finally {
		browser.tabs.onUpdated.removeListener(listener)
		checkAndPrintRuntimeLastError()
	}

	// if the tab is not ready yet try to wait for a while for it to be ready, if not, we just have no icon to show on firefox
	let maxRetries = 10
	// apparently there's a lot bugs in firefox related to getting this favicon. Eve if the tab has loaded, the favicon is not necessary loaded either
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1450384
	// https://bugzilla.mozilla.org/show_bug.cgi?id=1417721
	// below is my attempt to try to get favicon...
	while ((await safeGetTab(tabId))?.favIconUrl === undefined) {
		await new Promise(resolve => setTimeout(resolve, 100))
		maxRetries--
		if (maxRetries <= 0) break // timeout
	}
	const tab = await safeGetTab(tabId)
	return {
		title: tab?.title,
		icon: tab?.favIconUrl === undefined ? undefined : await imageToUri(tab.favIconUrl)
	}
}

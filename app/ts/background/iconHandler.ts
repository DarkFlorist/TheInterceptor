import { ICON_ACCESS_DENIED, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING, PRIMARY_COLOR, WARNING_COLOR } from '../utils/constants.js'
import { areWeBlocking, hasAccess, hasAddressAccess } from './accessManagement.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionBadgeText, setExtensionIcon, setExtensionTitle } from './backgroundUtils.js'
import { Future } from '../utils/future.js'
import { TabIcon, type TabState, type WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSettings, getWebsiteAccess } from './settings.js'
import { getRpcConnectionStatus, getTabState, removeTabState, updateTabState } from './storageVariables.js'
import { getLastKnownCurrentTabId } from './popupMessageHandlers.js'
import { checkAndPrintRuntimeLastError, doesTabExist, getMatchingWebsiteAccessOrigin, safeGetTab, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { modifyObject } from '../utils/typescript.js'
import { getRpcWarningState } from '../utils/rpcConnectionUi.js'
import { getPrettySignerName } from '../utils/signerMetadata.js'
import { imageToUri } from '../utils/imageToUri.js'
import { sanitizeStoredWebsiteIcon } from '../utils/websiteIcons.js'

const ALLOWED_FAVICON_PROTOCOLS = new Set(['http:', 'https:', 'data:'])

async function getCachedWebsiteIcon(tabId: number, websiteOrigin: string) {
	const storedWebsiteAccess = await getWebsiteAccess()
	const matchingWebsiteOrigin = getMatchingWebsiteAccessOrigin(storedWebsiteAccess.map((entry) => entry.website.websiteOrigin), websiteOrigin)
	const storedWebsite = matchingWebsiteOrigin === undefined ? undefined : storedWebsiteAccess.find((entry) => entry.website.websiteOrigin === matchingWebsiteOrigin)
	if (storedWebsite === undefined) return { cachedIcon: undefined, hasStoredWebsiteAccess: false as const }
	const currentWebsite = (await getTabState(tabId)).website
	if (currentWebsite !== undefined && getMatchingWebsiteAccessOrigin([currentWebsite.websiteOrigin], websiteOrigin) !== undefined) {
		const currentIcon = sanitizeStoredWebsiteIcon(currentWebsite.icon)
		if (currentIcon !== undefined) return { cachedIcon: currentIcon, hasStoredWebsiteAccess: true as const }
	}
	return { cachedIcon: sanitizeStoredWebsiteIcon(storedWebsite.website.icon), hasStoredWebsiteAccess: true as const }
}

async function setInterceptorIcon(tabId: number, icon: TabIcon, iconReason: string, popupRefreshGeneration: number) {
	const tabIconDetails = { icon, iconReason }
	if (!(await doesTabExist(tabId))) return
	const { previousState, newState } = await updateTabState(tabId, (previousState: TabState) => {
		const previousTabIconDetails = previousState.tabIconDetails
		if (previousTabIconDetails.icon === tabIconDetails.icon && previousTabIconDetails.iconReason === tabIconDetails.iconReason) return previousState
		return modifyObject(previousState, { tabIconDetails })
	})
	if (previousState === newState) return
	const iconChanged = previousState.tabIconDetails.icon !== icon
	const titleChanged = previousState.tabIconDetails.iconReason !== iconReason
	if (await getLastKnownCurrentTabId() === tabId) {
		await sendPopupMessageToOpenWindows({
			method: 'popup_websiteIconChanged',
			tabId,
			popupRefreshGeneration,
			data: tabIconDetails
		})
	}
	try {
		if (iconChanged) await setExtensionIcon({ path: { 128: icon }, tabId })
		if (titleChanged) await setExtensionTitle({ title: iconReason, tabId })
	} catch (error) {
		console.warn('failed to set interceptor icon and reason')
		console.warn(error)
	}
}

async function waitForLoadedTab(tabId: number) {
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
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			timeout = setTimeout(() => waitForLoadedFuture.reject(new Error('timed out')), 60000)
			await waitForLoadedFuture
		} finally {
			if (timeout !== undefined) clearTimeout(timeout)
		}
		return await safeGetTab(tabId)
	} finally {
		browser.tabs.onUpdated.removeListener(listener)
		checkAndPrintRuntimeLastError()
	}
}

export async function updateExtensionIcon(websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string, popupRefreshGeneration: number) {
	if (!(await doesTabExist(tabId))) {
		await removeTabState(tabId)
		return
	}
	const blockingWebsitePromise = areWeBlocking(websiteTabConnections, tabId, websiteOrigin)
	silenceChromeUnCaughtPromise(blockingWebsitePromise)
	const addShieldIfNeeded = async (icon: TabIcon): Promise<TabIcon> => await blockingWebsitePromise && icon !== ICON_INTERCEPTOR_DISABLED ? TabIcon.parse(icon.replace('.png', '-shield.png')) : icon
	const setIcon = async (icon: TabIcon, iconReason: string) => setInterceptorIcon(tabId, await addShieldIfNeeded(icon), await blockingWebsitePromise ? `${ iconReason } The Interceptor is blocking external requests made by the website.` : iconReason, popupRefreshGeneration)

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

export async function updateExtensionBadge() {
	const warningState = getRpcWarningState(await getRpcConnectionStatus())
	if (warningState.kind !== 'none') {
		await setExtensionBadgeBackgroundColor({ color: WARNING_COLOR })
		return await setExtensionBadgeText({ text: '!' })
	}
	await setExtensionBadgeBackgroundColor({ color: PRIMARY_COLOR })
	return await setExtensionBadgeText( { text: '' } )
}

export async function retrieveWebsiteDetails(tabId: number, websiteOrigin?: string) {
	let loadedTab
	try {
		loadedTab = await waitForLoadedTab(tabId)
	} catch {
		return { title: undefined, icon: undefined }
	}

	if (websiteOrigin !== undefined) {
		const { cachedIcon, hasStoredWebsiteAccess } = await getCachedWebsiteIcon(tabId, websiteOrigin)
		if (cachedIcon !== undefined) return { title: loadedTab?.title, icon: cachedIcon }
		if (!hasStoredWebsiteAccess) return { title: loadedTab?.title, icon: undefined }
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
	const pageUrl = tab?.url ?? 'unknown'
	const failToLoadFavicon = (reason: string) => {
		console.warn(`Failed to load favicon for tab ${ tabId } (${ pageUrl }): ${ reason }`)
		return { title: tab?.title, icon: undefined }
	}
	const faviconUrl = tab?.favIconUrl
	if (faviconUrl === undefined || faviconUrl === '') return { title: tab?.title, icon: undefined }

	let parsedFaviconUrl: URL
	try {
		parsedFaviconUrl = tab?.url === undefined ? new URL(faviconUrl) : new URL(faviconUrl, tab.url)
	} catch {
		return failToLoadFavicon(`invalid favicon URL ${ faviconUrl }`)
	}

	if (!ALLOWED_FAVICON_PROTOCOLS.has(parsedFaviconUrl.protocol)) {
		return failToLoadFavicon(`unsupported URL scheme ${ parsedFaviconUrl.protocol }`)
	}
	if (parsedFaviconUrl.protocol === 'data:') {
		const icon = sanitizeStoredWebsiteIcon(parsedFaviconUrl.toString())
		if (icon === undefined) return failToLoadFavicon('favicon data URL was not an image or exceeded the size limit')
		return {
			title: tab?.title,
			icon,
		}
	}
	if (tab?.url === undefined) return failToLoadFavicon('page URL was unavailable for favicon validation')
	const pageOrigin = new URL(tab.url).origin
	if (parsedFaviconUrl.origin !== pageOrigin) {
		return failToLoadFavicon(`favicon origin ${ parsedFaviconUrl.origin } did not match page origin ${ pageOrigin }`)
	}
	const faviconResult = await imageToUri(parsedFaviconUrl.toString())
	if (faviconResult.failureReason !== undefined || faviconResult.data === undefined) return failToLoadFavicon(faviconResult.failureReason ?? 'favicon conversion failed')
	return {
		title: tab?.title,
		icon: faviconResult.data,
	}
}

import { ICON_ACCESS_DENIED, ICON_ACTIVE, ICON_ACTIVE_WITH_SHIELD, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD, ICON_SIGNING_WITH_SHIELD, ICON_SIMULATING, ICON_SIMULATING_WITH_SHIELD, PRIMARY_COLOR, WARNING_COLOR } from '../utils/constants.js'
import { areWeBlocking } from './accessManagement.js'
import { hasAccess, hasAddressAccess } from './websiteAccessPolicy.js'
import { getActiveAddress, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionBadgeText, setExtensionIcon, setExtensionTitle } from './backgroundUtils.js'
import { createScopedKeyedSerialExecutor } from '../utils/semaphore.js'
import type { TabIcon, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSettings, getWebsiteAccess } from './settings.js'
import { getRpcConnectionStatus, getTabState, removeTabState, updateTabState } from './storageVariables.js'
import { getLastKnownCurrentTabId } from './currentTab.js'
import { doesTabExist, getHostWithPort, getTabIfExists, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { modifyObject } from '../utils/typescript.js'
import { getRpcWarningState } from '../utils/rpcConnectionUi.js'
import { getPrettySignerName, isSignerMissing } from '../utils/signerMetadata.js'
import { getNetworkWithoutRpcWarningState, getNetworkWithoutRpcWarningText } from '../utils/networkWithoutRpcUi.js'
import { imageToUri } from '../utils/imageToUri.js'
import { sanitizeStoredWebsiteIcon } from '../utils/websiteIcons.js'

const ALLOWED_FAVICON_PROTOCOLS = new Set(['http:', 'https:', 'data:'])

const blockingShieldIcons = {
	[ICON_ACTIVE]: ICON_ACTIVE_WITH_SHIELD,
	[ICON_ACCESS_DENIED]: ICON_ACCESS_DENIED,
	[ICON_NOT_ACTIVE]: ICON_NOT_ACTIVE_WITH_SHIELD,
	[ICON_SIMULATING]: ICON_SIMULATING_WITH_SHIELD,
	[ICON_SIGNING]: ICON_SIGNING_WITH_SHIELD,
	[ICON_SIGNING_NOT_SUPPORTED]: ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD,
	[ICON_INTERCEPTOR_DISABLED]: ICON_INTERCEPTOR_DISABLED,
	[ICON_ACTIVE_WITH_SHIELD]: ICON_ACTIVE_WITH_SHIELD,
	[ICON_NOT_ACTIVE_WITH_SHIELD]: ICON_NOT_ACTIVE_WITH_SHIELD,
	[ICON_SIMULATING_WITH_SHIELD]: ICON_SIMULATING_WITH_SHIELD,
	[ICON_SIGNING_WITH_SHIELD]: ICON_SIGNING_WITH_SHIELD,
	[ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD]: ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD,
} as const satisfies Record<TabIcon, TabIcon>

export function addBlockingShieldToIcon(icon: TabIcon): TabIcon {
	return blockingShieldIcons[icon]
}

async function getCachedWebsiteIcon(tabId: number, websiteOrigin: string) {
	const storedWebsiteAccess = await getWebsiteAccess()
	const storedWebsite = storedWebsiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
	if (storedWebsite === undefined) return { cachedIcon: undefined, hasStoredWebsiteAccess: false as const }
	const currentWebsite = (await getTabState(tabId)).website
	if (currentWebsite?.websiteOrigin === websiteOrigin) {
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

const runTabIconUpdate = createScopedKeyedSerialExecutor<object, number>()

export async function updateExtensionIcon(websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string, popupRefreshGeneration: number) {
	// Keep a tab's stored state and browser action writes ordered, without blocking active settings or other tabs.
	await runTabIconUpdate(browser, tabId, async () => {
		if (!(await doesTabExist(tabId))) {
			await removeTabState(tabId)
			return
		}
		const blockingWebsitePromise = areWeBlocking(websiteTabConnections, tabId, websiteOrigin)
		silenceChromeUnCaughtPromise(blockingWebsitePromise)
		const addShieldIfNeeded = async (icon: TabIcon): Promise<TabIcon> => await blockingWebsitePromise ? addBlockingShieldToIcon(icon) : icon
		const setIcon = async (icon: TabIcon, iconReason: string) => setInterceptorIcon(tabId, await addShieldIfNeeded(icon), await blockingWebsitePromise ? `${ iconReason } The Interceptor is blocking external requests made by the website.` : iconReason, popupRefreshGeneration)

		const settings = await getSettings()
		if (hasAccess(settings.websiteAccess, websiteOrigin) === 'interceptorDisabled') return setIcon(ICON_INTERCEPTOR_DISABLED, `The Interceptor is disabled for ${ websiteOrigin } by user request.`)
		const activeAddress = await getActiveAddress(settings, tabId)
		if (activeAddress === undefined) return setIcon(ICON_NOT_ACTIVE, 'No active address selected.')
		const addressAccess = hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress)
		if (addressAccess === 'askAccess') return setIcon(ICON_NOT_ACTIVE, `${ websiteOrigin } has PENDING access request for ${ activeAddress.name }!`)
		if (addressAccess !== 'hasAccess') {
			if (hasAccess(settings.websiteAccess, websiteOrigin) === 'noAccess') {
				return setIcon(ICON_ACCESS_DENIED, `The access for ${ websiteOrigin } has been DENIED!`)
			}
			return setIcon(ICON_ACCESS_DENIED, `The access to ${ activeAddress.name } for ${ websiteOrigin } has been DENIED!`)
		}
		if (settings.simulationMode) return setIcon(ICON_SIMULATING, 'The Interceptor simulates your sent transactions.')
		const tabState = await getTabState(tabId)
		const networkWithoutRpcWarningState = getNetworkWithoutRpcWarningState(settings.activeRpcNetwork, settings.simulationMode, isSignerMissing(tabState.signerName) ? 'missing' : 'available')
		if (networkWithoutRpcWarningState.kind !== 'none') return setIcon(ICON_SIGNING_NOT_SUPPORTED, getNetworkWithoutRpcWarningText(settings.activeRpcNetwork.name, networkWithoutRpcWarningState))
		return setIcon(ICON_SIGNING, `The Interceptor forwards your transactions to ${ getPrettySignerName(tabState.signerName) } once sent.`)
	})
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
	// Metadata is cosmetic: a page may keep loading while it waits for wallet RPC, so never wait for tab load or favicon events here.
	const tab = await getTabIfExists(tabId)
	if (tab === undefined) return { title: undefined, icon: undefined }
	const cached = websiteOrigin === undefined ? undefined : await getCachedWebsiteIcon(tabId, websiteOrigin)
	// A child frame has its own origin. The outer tab's title and favicon must never identify that child in a permission prompt.
	const matchesTab = websiteOrigin === undefined || (tab.url !== undefined && getHostWithPort(tab.url) === websiteOrigin)
	if (!matchesTab || tab.status !== 'complete') return { title: undefined, icon: cached?.cachedIcon }
	if (cached?.cachedIcon !== undefined) return { title: tab.title, icon: cached.cachedIcon }
	if (cached?.hasStoredWebsiteAccess === false) return { title: tab.title, icon: undefined }

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

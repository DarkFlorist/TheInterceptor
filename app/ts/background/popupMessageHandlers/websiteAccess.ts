import { startBackgroundTask } from '../backgroundTasks.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { AllowOrPreventAddressAccessForWebsite, BlockOrAllowExternalRequests, DisableInterceptor, RemoveWebsiteAccess, RemoveWebsiteAddressAccess, RetrieveWebsiteAccess } from '../../types/interceptor-messages.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, reportUnexpectedError } from '../../utils/errors.js'
import { checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { modifyObject } from '../../utils/typescript.js'
import { setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getTabState } from '../storageVariables.js'
import { getLastKnownCurrentTabId } from '../currentTab.js'
import { getSettings, updateWebsiteAccess } from '../settings.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAddressMetadataForAccess } from '../windows/interceptorAccess.js'
import { searchWebsiteAccess } from '../websiteAccessSearch.js'
import { updateWebsiteAccessAndContentScriptInjectionStrategy } from '../websiteAccessUpdating.js'

const isMissingTabReloadError = (error: unknown) => {
	const message = getErrorMessage(error)
	return message !== undefined && (message.startsWith('No tab with id') || message.includes('Invalid tab ID'))
}

export async function reloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, websiteOrigin?: string) {
	const tabIdsToRefresh = [...websiteTabConnections.entries()].filter(([, tab]) => websiteOrigin === undefined || Object.values(tab.connections).some(connection => connection.websiteOrigin === websiteOrigin)).map(([tabId]) => tabId)
	const currentTabId = await getLastKnownCurrentTabId()
	const currentWebsite = currentTabId === undefined ? undefined : (await getTabState(currentTabId)).website
	const withCurrentTabId = currentTabId !== undefined && (websiteOrigin === undefined || currentWebsite?.websiteOrigin === websiteOrigin) ? [...tabIdsToRefresh, currentTabId] : tabIdsToRefresh
	await Promise.all([...new Set(withCurrentTabId)].map(async tabId => {
		try {
			await browser.tabs.reload(tabId)
			checkAndThrowRuntimeLastError()
		} catch (error) {
			if (isMissingTabReloadError(error)) return
			await reportUnexpectedError(error, { code: 'connected_tab_reload_failed' })
		}
	}))
}

export const disableInterceptorForPage = async (website: Website, interceptorDisabled: boolean) => {
	await setInterceptorDisabledForWebsite(website, interceptorDisabled)
}

export async function disableInterceptor(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await disableInterceptorForPage(parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true, false, { deferUiUpdates: true })
	startBackgroundTask(async () => await reloadConnectedTabs(websiteTabConnections, parsedRequest.data.website.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess, settings.activeRpcNetwork.chainId)
	await sendPopupMessageToOpenWindows({ method: 'popup_retrieveWebsiteAccessReply', data: { websiteAccess, addressAccessMetadata } })
}

const blockOrAllowWebsiteExternalRequests = async (website: Website, shouldBlock: boolean) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== website.websiteOrigin) return access
		return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
	}))
}

export async function blockOrAllowExternalRequests(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await blockOrAllowWebsiteExternalRequests(parsedRequest.data.website, parsedRequest.data.shouldBlock)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true, false, { deferUiUpdates: true })
	startBackgroundTask(async () => await reloadConnectedTabs(websiteTabConnections, parsedRequest.data.website.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

const removeAddressAccessByAddress = async (websiteOrigin: string, address: EthereumAddress) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
		return modifyObject(access, { addressAccess: access.addressAccess.filter((addressAccess) => addressAccess.address !== address) })
	}))
}

export async function removeWebsiteAddressAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await removeAddressAccessByAddress(parsedRequest.data.websiteOrigin, parsedRequest.data.address)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true, false, { deferUiUpdates: true })
	startBackgroundTask(async () => await reloadConnectedTabs(websiteTabConnections, parsedRequest.data.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

const setAddressAccessForWebsite = async (websiteOrigin: string, address: EthereumAddress, allowAccess: boolean) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== websiteOrigin || access.addressAccess === undefined) return access
		const addressAccess = access.addressAccess.map((entry) => entry.address === address ? modifyObject(entry, { access: allowAccess }) : entry)
		return modifyObject(access, { addressAccess })
	}))
}

export async function allowOrPreventAddressAccessForWebsite(websiteTabConnections: WebsiteTabConnections, parsedRequest: AllowOrPreventAddressAccessForWebsite) {
	const { website, address, allowAccess } = parsedRequest.data
	await setAddressAccessForWebsite(website.websiteOrigin, address, allowAccess)
	await updateWebsiteApprovalAccesses(undefined, websiteTabConnections, await getSettings(), false, false, { deferUiUpdates: true })
	startBackgroundTask(async () => await reloadConnectedTabs(websiteTabConnections, website.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	await updateWebsiteAccessAndContentScriptInjectionStrategy((previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== parsedRequest.data.websiteOrigin))
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true, false, { deferUiUpdates: true })
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

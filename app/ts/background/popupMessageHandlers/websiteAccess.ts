import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { AllowOrPreventAddressAccessForWebsite, BlockOrAllowExternalRequests, DisableInterceptor, RemoveWebsiteAccess, RemoveWebsiteAddressAccess, RetrieveWebsiteAccess } from '../../types/interceptor-messages.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import type { Website, WebsiteAccess, WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, reportUnexpectedError } from '../../utils/errors.js'
import { checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { modifyObject } from '../../utils/typescript.js'
import { getWebsiteHostname, shareNetworkBlocking } from '../../utils/websiteOrigin.js'
import { setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
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

export async function reloadConnectedTabs(websiteTabConnections: WebsiteTabConnections) {
	const tabIdsToRefresh = Array.from(websiteTabConnections.keys())
	const currentTabId = await getLastKnownCurrentTabId()
	const withCurrentTabId = currentTabId === undefined ? tabIdsToRefresh : [...tabIdsToRefresh, currentTabId]
	for (const tabId of new Set(withCurrentTabId)) {
		try {
			await browser.tabs.reload(tabId)
			checkAndThrowRuntimeLastError()
		} catch (error) {
			if (isMissingTabReloadError(error)) continue
			await reportUnexpectedError(error, { code: 'connected_tab_reload_failed' })
		}
	}
}

export const disableInterceptorForPage = async (websiteTabConnections: WebsiteTabConnections, website: Website, interceptorDisabled: boolean) => {
	await setInterceptorDisabledForWebsite(website, interceptorDisabled)
	await reloadConnectedTabs(websiteTabConnections)
}

export async function disableInterceptor(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await disableInterceptorForPage(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess, settings.activeRpcNetwork.chainId)
	await sendPopupMessageToOpenWindows({ method: 'popup_retrieveWebsiteAccessReply', data: { websiteAccess, addressAccessMetadata } })
}

// Network blocking is enforced per hostname across every scheme and port (updateDeclarativeNetRequestBlocks), so a toggle sets every record sharing the hostname. Updating only the selected origin would let another scheme's record keep blocking it while its toggle shows it as unblocked.
export function setNetworkBlockModeForHostname(websiteAccess: WebsiteAccessArray, websiteOrigin: string, shouldBlock: boolean): WebsiteAccessArray {
	return websiteAccess.map((access) => {
		if (!shareNetworkBlocking(access.website.websiteOrigin, websiteOrigin)) return access
		return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
	})
}

type NetworkBlockDecision = { readonly websiteOrigin: string, readonly shouldBlock: boolean }
type WebsiteAccessEdit = { readonly removed: boolean, readonly oldEntry: WebsiteAccess, readonly newEntry: WebsiteAccess }

const blocksNetworkRequests = (access: WebsiteAccess) => access.declarativeNetRequestBlockMode === 'block-all'

// A save's explicit block toggles, one per hostname (or per origin without one). Throws before anything is written when two toggles of one hostname disagree, since enforcement cannot block a hostname for one scheme and not another. The access-list editor keeps a hostname's toggles equal (setEditableNetworkBlockMode), so this only rejects a crafted or stale message.
export function getNetworkBlockDecisions(edits: readonly WebsiteAccessEdit[]): readonly NetworkBlockDecision[] {
	const decisions = new Map<string, NetworkBlockDecision>()
	for (const edit of edits) {
		if (edit.removed || blocksNetworkRequests(edit.oldEntry) === blocksNetworkRequests(edit.newEntry)) continue
		const websiteOrigin = edit.newEntry.website.websiteOrigin
		const decision = { websiteOrigin, shouldBlock: blocksNetworkRequests(edit.newEntry) }
		const hostname = getWebsiteHostname(websiteOrigin)
		const decisionKey = hostname === undefined ? `origin:${ websiteOrigin }` : `hostname:${ hostname }`
		const previous = decisions.get(decisionKey)
		if (previous !== undefined && previous.shouldBlock !== decision.shouldBlock) {
			throw new Error(`Cannot both block and allow external requests for ${ hostname ?? websiteOrigin }: ${ previous.websiteOrigin } and ${ websiteOrigin } share its network blocking. Set them to the same value.`)
		}
		decisions.set(decisionKey, decision)
	}
	return [...decisions.values()]
}

// Apply ordinary record edits first, then each explicit block toggle across its whole hostname, so another edited record of that hostname carrying its old block mode cannot undo the toggle.
export function applyWebsiteAccessEdits(websiteAccess: WebsiteAccessArray, edits: readonly WebsiteAccessEdit[], networkBlockDecisions: readonly NetworkBlockDecision[]): WebsiteAccessArray {
	const withEntriesRemoved = websiteAccess.filter((access) => edits.find((edit) => edit.newEntry.website.websiteOrigin === access.website.websiteOrigin)?.removed !== true)
	const withRecordEdits = withEntriesRemoved.map((access) => edits.find((edit) => edit.newEntry.website.websiteOrigin === access.website.websiteOrigin)?.newEntry ?? access)
	return networkBlockDecisions.reduce<WebsiteAccessArray>((accessList, decision) => setNetworkBlockModeForHostname(accessList, decision.websiteOrigin, decision.shouldBlock), withRecordEdits)
}

const blockOrAllowWebsiteExternalRequests = async (websiteTabConnections: WebsiteTabConnections, website: Website, shouldBlock: boolean) => {
	await updateWebsiteAccess((previousAccessList) => setNetworkBlockModeForHostname(previousAccessList, website.websiteOrigin, shouldBlock))
	await reloadConnectedTabs(websiteTabConnections)
}

export async function blockOrAllowExternalRequests(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await blockOrAllowWebsiteExternalRequests(websiteTabConnections, parsedRequest.data.website, parsedRequest.data.shouldBlock)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
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
	await reloadConnectedTabs(websiteTabConnections)
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
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
	await reloadConnectedTabs(websiteTabConnections)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	await updateWebsiteAccessAndContentScriptInjectionStrategy((previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== parsedRequest.data.websiteOrigin))
	await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

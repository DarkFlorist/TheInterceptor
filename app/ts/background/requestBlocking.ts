import { getActiveAddressesForAllTabs } from './backgroundUtils.js'
import { getActiveAddresses } from './metadataUtils.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { getSettingsSnapshot, getWebsiteApprovalsSnapshot, requireReadableApprovals, settingsIfRpcConfigurationReady, type ReadyRpcSettings } from './settings.js'
import { getHostWithPort } from '../utils/requests.js'
import { getAllTabStates } from './storageVariables.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { getWebsiteAccessForAddress, hasAccess } from './websiteAccessPolicy.js'

// Request blocking: which tabs and sites the user's block-all settings block, and the MV2/MV3 rules that enforce it. Connection approval stays in accessManagement.ts, which updates the blocks whenever approvals change (connectToPort, reconcileWebsiteApprovalAccessesCollectingFailures); this module only reads the approvals.

// Tab blocking fails closed: a tab is blocked while any of its connections is approved at runtime or has persisted consent for the tab's active address. A connection whose consent was just denied stays approved until a reconciliation disconnects it (and some denials, such as setAddressAccessForWebsite's, are not reconciled when written), so the block must not be lifted while the connection can still make requests; a connection that is consented but not yet approved is about to be.
const tabHasApprovedOrConsentedConnection = (websiteTabConnections: WebsiteTabConnections, websiteAccess: WebsiteAccessArray, tabId: number, activeAddress: AddressBookEntry | undefined) => Object.values(websiteTabConnections.get(tabId)?.connections ?? {}).some((connection) => connection.approved || getWebsiteAccessForAddress(websiteAccess, connection.websiteOrigin, activeAddress) === 'hasAccess')

// Without a ready RPC configuration a tab's active address cannot be trusted for its chain, and runtime connection approval is not restored either (connections register unapproved and requests are refused before access checks). Tab blocking is a user privacy control that must not depend on RPC availability, so fail closed: block every connected tab that is approved at runtime or whose website has persisted consent, while any active address blocks all external requests.
const getTabIdsToBlockWithoutReadyRpcConfiguration = async (websiteTabConnections: WebsiteTabConnections, websiteAccess: WebsiteAccessArray) => {
	const anyActiveAddressBlocksAll = (await getActiveAddresses()).some((entry) => entry.declarativeNetRequestBlockMode === 'block-all')
	if (!anyActiveAddressBlocksAll) return []
	const tabIdsToBlock: number[] = []
	for (const [tabId, tabConnection] of websiteTabConnections.entries()) {
		const tabHasConsentedConnection = Object.values(tabConnection.connections).some((connection) => connection.approved || hasAccess(websiteAccess, connection.websiteOrigin) === 'hasAccess')
		if (tabHasConsentedConnection) tabIdsToBlock.push(tabId)
	}
	return tabIdsToBlock
}

type RequestBlocks = {
	readonly tabIdsToBlock: readonly number[]
	readonly sitesToBlock: readonly string[]
	// Which tab blocks that are already applied must be kept, never lifted, because the tab set is only a lower bound for them: every one while the RPC configuration is not ready, afterwards those of tabs still waiting for their approval.
	readonly keepAppliedTabBlock: (tabId: number) => boolean
}

const getSitesToBlock = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((access) => access.declarativeNetRequestBlockMode === 'block-all').map((acccess) => acccess.website.websiteOrigin)

// The single tab-blocking mode decision: undefined (the RPC configuration is not ready, even if it kept a readable active network) means tab blocking is derived from persisted consent.
const getSettingsForTabBlocking = async () => settingsIfRpcConfigurationReady(await getSettingsSnapshot())

// Runtime approvals return only after recovery: a tab registered during an outage, or reconnecting after a restart, is unapproved at first, so approvals alone would lift a block that persisted consent put in place. Such a block stays while the tab's website has that consent and its active address blocks everything or is not known yet; the grant that follows reconciles it (see connectToPort). A restarted worker has no connections yet, so the tab's stored website counts too.
const getConsentedTabIdsAwaitingApproval = async (websiteTabConnections: WebsiteTabConnections, websiteAccess: WebsiteAccessArray, tabAddresses: readonly { readonly tabId: number, readonly activeAddress: AddressBookEntry | undefined }[]) => {
	const anyActiveAddressBlocksAll = (await getActiveAddresses()).some((entry) => entry.declarativeNetRequestBlockMode === 'block-all')
	const addressMayBlockAll = (tabId: number) => {
		const activeAddress = tabAddresses.find((tabData) => tabData.tabId === tabId)?.activeAddress
		return activeAddress === undefined ? anyActiveAddressBlocksAll : activeAddress.declarativeNetRequestBlockMode === 'block-all'
	}
	const getTabWebsiteOrigins = (tabState: TabState) => [tabState.website?.websiteOrigin, ...Object.values(websiteTabConnections.get(tabState.tabId)?.connections ?? {}).map((connection) => connection.websiteOrigin)]
	const tabHasConsent = (tabState: TabState) => {
		const activeAddress = tabAddresses.find((tabData) => tabData.tabId === tabState.tabId)?.activeAddress
		return getTabWebsiteOrigins(tabState).some((websiteOrigin) => websiteOrigin !== undefined && getWebsiteAccessForAddress(websiteAccess, websiteOrigin, activeAddress) === 'hasAccess')
	}
	return new Set((await getAllTabStates()).filter((tabState) => addressMayBlockAll(tabState.tabId) && tabHasConsent(tabState)).map((tabState) => tabState.tabId))
}

const getTabsAndAddressesToBlock = async (websiteTabConnections: WebsiteTabConnections): Promise<RequestBlocks> => {
	const settings = await getSettingsForTabBlocking()
	if (settings === undefined) {
		// A fresh read on purpose: when storage is unreadable the snapshot's fail-closed approvals are empty, which would lift applied site blocks, so this read (like getActiveAddresses) rejects and every applied rule stays in place.
		const websiteAccess = requireReadableApprovals(await getWebsiteApprovalsSnapshot({ repairCorrupt: true }))
		return { tabIdsToBlock: await getTabIdsToBlockWithoutReadyRpcConfiguration(websiteTabConnections, websiteAccess), sitesToBlock: getSitesToBlock(websiteAccess), keepAppliedTabBlock: () => true }
	}
	return await getRequestBlocksWithReadyRpcConfiguration(websiteTabConnections, settings)
}

// Tab blocking from runtime approvals, which only a ready RPC configuration may decide: the parameter type admits only settingsIfRpcConfigurationReady's result.
const getRequestBlocksWithReadyRpcConfiguration = async (websiteTabConnections: WebsiteTabConnections, settings: ReadyRpcSettings): Promise<RequestBlocks> => {
	const tabAddresses = await getActiveAddressesForAllTabs(settings)
	const websiteAccess = requireReadableApprovals(await getWebsiteApprovalsSnapshot({ repairCorrupt: true }))
	const tabIdsToBlock = tabAddresses.filter(({ tabId, activeAddress }) => activeAddress?.declarativeNetRequestBlockMode === 'block-all' && tabHasApprovedOrConsentedConnection(websiteTabConnections, websiteAccess, tabId, activeAddress)).map((tabData) => tabData.tabId)
	const tabIdsAwaitingApproval = await getConsentedTabIdsAwaitingApproval(websiteTabConnections, websiteAccess, tabAddresses)
	return { tabIdsToBlock, sitesToBlock: getSitesToBlock(websiteAccess), keepAppliedTabBlock: (tabId) => tabIdsAwaitingApproval.has(tabId) }
}

let webRequestListener: (details: browser.webRequest._OnBeforeRequestDetails) => void = () => undefined
let previousTabIdsToBlock: readonly number[] = []
let previousSitesToBlock: readonly string[] = []
let previousTabBlockIdentifier: string | undefined
let previousSiteBlockIdentifier: string | undefined
// MV3 session rules survive service-worker restarts, so they are the authoritative record of applied tab blocks; MV2 listeners do not survive a restart.
const getAppliedTabBlocks = async (): Promise<readonly number[]> => {
	if (browser.runtime.getManifest().manifest_version !== 3) return previousTabIdsToBlock
	return (await browser.declarativeNetRequest.getSessionRules()).flatMap((rule) => rule.condition.tabIds ?? [])
}

const getAppliedSiteBlocks = async (): Promise<readonly string[]> => {
	if (browser.runtime.getManifest().manifest_version !== 3) return previousSitesToBlock
	return (await browser.declarativeNetRequest.getDynamicRules()).flatMap((rule) => rule.condition.initiatorDomains ?? [])
}

const withKeptAppliedTabBlocks = async ({ tabIdsToBlock, keepAppliedTabBlock }: RequestBlocks) => Array.from(new Set([...(await getAppliedTabBlocks()).filter(keepAppliedTabBlock), ...tabIdsToBlock]))

const updateDeclarativeNetRequestBlocksSemaphore = new Semaphore(1)
export async function updateDeclarativeNetRequestBlocks(websiteTabConnections: WebsiteTabConnections) {
	return await updateDeclarativeNetRequestBlocksSemaphore.execute(async () => {
		const requestBlocks = await getTabsAndAddressesToBlock(websiteTabConnections)
		const { sitesToBlock } = requestBlocks
		const tabIdsToBlock = await withKeptAppliedTabBlocks(requestBlocks)
		const tabBlockIdentifier = tabIdsToBlock.join('|')
		const siteBlockIdentifier = sitesToBlock.join('|')
		const tabBlocksChanged = tabBlockIdentifier !== previousTabBlockIdentifier
		const siteBlocksChanged = siteBlockIdentifier !== previousSiteBlockIdentifier
		if (!tabBlocksChanged && !siteBlocksChanged) return

		if (browser.runtime.getManifest().manifest_version === 3) {
			if (siteBlocksChanged) {
				const dynamicRuleIds = (await browser.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
				if (sitesToBlock.length !== 0) {
					await browser.declarativeNetRequest.updateDynamicRules({
						removeRuleIds: dynamicRuleIds,
						addRules: [{
							id: dynamicRuleIds.length === 0 ? 1 : Math.max.apply(null, dynamicRuleIds) + 1,
							priority: 1,
							action : { type: 'block' as const },
							condition: { initiatorDomains: [...sitesToBlock], domainType: 'thirdParty' as const }
						}]
					})
				} else {
					await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamicRuleIds })
				}
				previousSitesToBlock = sitesToBlock
				previousSiteBlockIdentifier = siteBlockIdentifier
			}
			if (tabBlocksChanged) {
				const sessionRuleIds = (await browser.declarativeNetRequest.getSessionRules()).map((rule) => rule.id)
				if (tabIdsToBlock.length !== 0) {
					await browser.declarativeNetRequest.updateSessionRules({
						removeRuleIds: sessionRuleIds,
						addRules: [{
							id: sessionRuleIds.length === 0 ? 1 : Math.max.apply(null, sessionRuleIds) + 1,
							priority: 2,
							action : { type: 'block' as const },
							condition: { tabIds: [...tabIdsToBlock], domainType: 'thirdParty' as const }
						}]
					})
				} else {
					await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionRuleIds })
				}
				previousTabIdsToBlock = tabIdsToBlock
				previousTabBlockIdentifier = tabBlockIdentifier
			}
			// enable `declarativeNetRequestFeedback` permission to manifest and uncomment to enable debugging
			// const a = (data: any) => { console.log(data) }
			// (browser.declarativeNetRequest as any).onRuleMatchedDebug.addListener(a)
		} else {
			browser.webRequest.onBeforeRequest.removeListener(webRequestListener)
			// Nothing is applied until the replacement listener is installed, so a failed installation reports no blocking and the next reconciliation retries it.
			previousSitesToBlock = []
			previousTabIdsToBlock = []
			previousSiteBlockIdentifier = undefined
			previousTabBlockIdentifier = undefined
			webRequestListener = (details: browser.webRequest._OnBeforeRequestDetails) => {
				if (tabIdsToBlock.find((tabId) => tabId === details.tabId) !== undefined) return { cancel: true }
				if (details.originUrl === undefined) return {}
				if (details.type === 'main_frame') return {}
				const websiteOrigin = getHostWithPort(details.originUrl)
				const destinationHost = getHostWithPort(details.url)
				if (destinationHost === websiteOrigin) return {}
				if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return { cancel: true }
				return {}
			}
			if (sitesToBlock.length !== 0 || tabIdsToBlock.length !== 0) browser.webRequest.onBeforeRequest.addListener(webRequestListener, { urls: ['<all_urls>'] }, ['blocking'])
			previousSitesToBlock = sitesToBlock
			previousTabIdsToBlock = tabIdsToBlock
			previousSiteBlockIdentifier = siteBlockIdentifier
			previousTabBlockIdentifier = tabBlockIdentifier
		}
	})
}

// A pure query of the blocking that is in force: only rules that were successfully applied count, and enforcement belongs to updateDeclarativeNetRequestBlocks.
export const areWeBlocking = async (tabId: number, websiteOrigin: string) => {
	const [appliedSiteBlocks, appliedTabBlocks] = await Promise.all([getAppliedSiteBlocks(), getAppliedTabBlocks()])
	return appliedSiteBlocks.includes(websiteOrigin) || appliedTabBlocks.includes(tabId)
}

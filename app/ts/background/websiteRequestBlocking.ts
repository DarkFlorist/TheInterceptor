import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getHostWithPort } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { getActiveAddressesForAllTabs } from './backgroundUtils.js'
import { getSettings, getWebsiteAccess } from './settings.js'

const getApprovedTabs = (websiteTabConnections: WebsiteTabConnections) => {
	const approvedTabs = new Set<number>()
	for (const [tab, tabConnection] of websiteTabConnections.entries()) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection?.approved) {
				approvedTabs.add(tab)
				continue
			}
		}
	}
	return approvedTabs
}
const getTabsAndAddressesToBlock = async (websiteTabConnections: WebsiteTabConnections) => {
	const approvedTabIds = getApprovedTabs(websiteTabConnections)
	const tabIdsToBlock = (await getActiveAddressesForAllTabs(await getSettings())).filter((tabData) => approvedTabIds.has(tabData.tabId)).filter((tabData) => tabData.activeAddress?.declarativeNetRequestBlockMode === 'block-all').map((tabData) => tabData.tabId)
	const sitesToBlock = (await getWebsiteAccess()).filter((access) => access.declarativeNetRequestBlockMode === 'block-all').map((acccess) => acccess.website.websiteOrigin)
	return {
		tabIdsToBlock,
		sitesToBlock
	}
}

let webRequestListener: (details: browser.webRequest._OnBeforeRequestDetails) => void = () => undefined
let previousDecralativeNetRequestBlockIdentifier = ''
const updateDeclarativeNetRequestBlocksSemaphore = new Semaphore(1)
export async function updateDeclarativeNetRequestBlocks(websiteTabConnections: WebsiteTabConnections) {
	return await updateDeclarativeNetRequestBlocksSemaphore.execute(async () => {
		const { tabIdsToBlock, sitesToBlock } = await getTabsAndAddressesToBlock(websiteTabConnections)
		// check if the rules would change, if not, just bail out
		const decralativeNetRequestBlockIdentifier = `${ tabIdsToBlock.join('|') }|a|${ sitesToBlock.join('|') }`
		if (decralativeNetRequestBlockIdentifier === previousDecralativeNetRequestBlockIdentifier) return

		if (browser.runtime.getManifest().manifest_version === 3) {
			const dynamicRuleIds = (await browser.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
			const sessionRuleIds = (await browser.declarativeNetRequest.getSessionRules()).map((rule) => rule.id)
			if (sitesToBlock.length !== 0) {
				await browser.declarativeNetRequest.updateDynamicRules({
					removeRuleIds: dynamicRuleIds,
					addRules: [{
						id: dynamicRuleIds.length === 0 ? 1 : Math.max.apply(null, dynamicRuleIds) + 1,
						priority: 1,
						action : { type: 'block' as const },
						condition: { initiatorDomains: sitesToBlock, domainType: 'thirdParty' as const }
					}]
				})
			} else {
				await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamicRuleIds })
			}
			if (tabIdsToBlock.length !== 0) {
				await browser.declarativeNetRequest.updateSessionRules({
					removeRuleIds: sessionRuleIds,
					addRules: [{
						id: sessionRuleIds.length === 0 ? 1 : Math.max.apply(null, sessionRuleIds) + 1,
						priority: 2,
						action : { type: 'block' as const },
						condition: { tabIds: tabIdsToBlock, domainType: 'thirdParty' as const }
					}]
				})
			} else {
				await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionRuleIds })
			}
			// enable `declarativeNetRequestFeedback` permission to manifest and uncomment to enable debugging
			// const a = (data: any) => { console.log(data) }
			// (browser.declarativeNetRequest as any).onRuleMatchedDebug.addListener(a)
			previousDecralativeNetRequestBlockIdentifier = decralativeNetRequestBlockIdentifier
		} else {
			browser.webRequest.onBeforeRequest.removeListener(webRequestListener)
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
			if (sitesToBlock.length === 0 && tabIdsToBlock.length === 0) {
				previousDecralativeNetRequestBlockIdentifier = decralativeNetRequestBlockIdentifier
				return
			}
			browser.webRequest.onBeforeRequest.addListener(webRequestListener, { urls: ['<all_urls>'] }, ['blocking'])
			previousDecralativeNetRequestBlockIdentifier = decralativeNetRequestBlockIdentifier
		}
	})
}

export const areWeBlocking = async (websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) => {
	const { tabIdsToBlock, sitesToBlock } = await getTabsAndAddressesToBlock(websiteTabConnections)
	if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return true
	if (tabIdsToBlock.find((blockTab) => blockTab === tabId) !== undefined) return true
	return false
}

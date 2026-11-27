import { getExtensionTabReuse, type ExtensionTabName } from './extensionTabPolicy.js'
import { getHtmlFile } from '../utils/htmlPages.js'
import { getIdsOfOpenedTabs, setIdsOfOpenedTabs } from './storageVariables.js'
import { updateTabIfExists, updateWindowIfExists } from '../utils/requests.js'

export const openExtensionTab = async (tabName: ExtensionTabName, targetSuffix = '') => {
	const targetUrl = `${ getHtmlFile(tabName) }${ targetSuffix }`
	const resolvedTargetUrl = new URL(targetUrl, browser.runtime.getURL('/'))
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: targetUrl })
		if (tab.id !== undefined) await setIdsOfOpenedTabs({ [tabName]: tab.id })
	}

	const tabId = (await getIdsOfOpenedTabs())[tabName]
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const existingTab = allTabs.find((tab) => tab.id === tabId)

	if (existingTab?.id === undefined) return await openInNewTab()
	const reuse = getExtensionTabReuse(tabName, { targetUrl, resolvedTargetUrl, currentTabUrl: existingTab.url, targetSuffix })
	if (reuse.action === 'open') return await openInNewTab()
	const tab = await updateTabIfExists(existingTab.id, { active: true, highlighted: true, ...reuse.url === undefined ? {} : { url: reuse.url } })
	if (tab === undefined) return await openInNewTab()
	if (tab?.windowId !== undefined) await updateWindowIfExists(tab.windowId, { focused: true })
}

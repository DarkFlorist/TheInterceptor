import type { ChangePage, OpenWebPage } from '../../types/interceptor-messages.js'
import { checkAndThrowRuntimeLastError, updateTabIfExists, updateWindowIfExists } from '../../utils/requests.js'
import { getHtmlFile } from '../backgroundUtils.js'
import { setPage } from '../settings.js'
import { getIdsOfOpenedTabs, setIdsOfOpenedTabs } from '../storageVariables.js'

export const changePage = async (page: ChangePage) => await setPage(page.data)

type ExtensionTabName = 'settingsView' | 'addressBook' | 'websiteAccess' | 'simulationStack'

type ExistingTabUpdate = {
	active: true
	highlighted: true
	url?: string
}

function getExistingTabUpdate(tabName: ExtensionTabName, targetUrl: string, resolvedTargetUrl: URL, currentTabUrl: string | undefined, targetHash: string): ExistingTabUpdate {
	const url = getExistingTabUrlUpdate(tabName, targetUrl, resolvedTargetUrl, currentTabUrl, targetHash)
	if (url === undefined) return { active: true, highlighted: true }
	return { active: true, highlighted: true, url }
}

function getExistingTabUrlUpdate(tabName: ExtensionTabName, targetUrl: string, resolvedTargetUrl: URL, currentTabUrl: string | undefined, targetHash: string) {
	if (targetHash.length !== 0) return targetUrl
	if (tabName !== 'simulationStack') return undefined
	if (currentTabUrl === undefined) return undefined
	return shouldClearSimulationStackHash(currentTabUrl, targetUrl, resolvedTargetUrl) ? targetUrl : undefined
}

function shouldClearSimulationStackHash(currentTabUrl: string, targetUrl: string, resolvedTargetUrl: URL) {
	try {
		const currentUrl = new URL(currentTabUrl, browser.runtime.getURL('/'))
		return currentUrl.pathname !== resolvedTargetUrl.pathname || currentUrl.hash !== ''
	} catch {
		return currentTabUrl !== targetUrl
	}
}

export const openNewTab = async (tabName: ExtensionTabName, targetHash = '') => {
	const targetUrl = `${ getHtmlFile(tabName) }${ targetHash }`
	const resolvedTargetUrl = new URL(targetUrl, browser.runtime.getURL('/'))
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: targetUrl })
		if (tab.id !== undefined) await setIdsOfOpenedTabs({ [tabName]: tab.id })
	}

	const tabId = (await getIdsOfOpenedTabs())[tabName]
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	const tab = await updateTabIfExists(addressBookTab.id, getExistingTabUpdate(tabName, targetUrl, resolvedTargetUrl, addressBookTab.url, targetHash))
	if (tab === undefined) return await openInNewTab()
	if (tab?.windowId !== undefined) await updateWindowIfExists(tab.windowId, { focused: true })
}

export async function openWebPage(parsedRequest: OpenWebPage) {
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === parsedRequest.data.websiteSocket.tabId)
	if (addressBookTab === undefined) {
		await browser.tabs.create({ url: parsedRequest.data.url, active: true })
		return
	}
	try {
		await browser.tabs.update(parsedRequest.data.websiteSocket.tabId, { url: parsedRequest.data.url, active: true })
		checkAndThrowRuntimeLastError()
		return
	} catch (error) {
		console.warn('Failed to update tab with new webpage')
		console.warn({ error })
	}
	await browser.tabs.create({ url: parsedRequest.data.url, active: true })
}

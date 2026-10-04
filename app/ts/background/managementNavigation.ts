import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getManagementPageHash, type ManagementPage } from '../utils/managementPages.js'
import { getSimulationStackManagementHash } from '../utils/simulationStackTargets.js'
import { updateTabIfExists, updateWindowIfExists } from '../utils/requests.js'
import { getHtmlFile } from './backgroundUtils.js'
import { getManagementTabId, setManagementTabId } from './storageVariables.js'
import { getUseTabsInsteadOfPopup } from './settings.js'

function managementPagePath() {
	return getHtmlFile('settingsView')
}

async function openManagementTab(targetHash: string) {
	const pagePath = managementPagePath()
	const pageUrl = browser.runtime.getURL(pagePath)
	const targetUrl = `${ pagePath }${ targetHash }`
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: targetUrl })
		if (tab.id !== undefined) await setManagementTabId(tab.id)
	}

	const tabId = await getManagementTabId()
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const managementTab = allTabs.find((tab) => tab.id === tabId)

	if (managementTab?.id === undefined || (managementTab.url !== undefined && managementTab.url.split('#', 1)[0] !== pageUrl)) return await openInNewTab()
	const tab = await updateTabIfExists(managementTab.id, { active: true, highlighted: true, url: targetUrl })
	if (tab === undefined) return await openInNewTab()
	if (tab.windowId !== undefined) await updateWindowIfExists(tab.windowId, { focused: true })
}

export async function openManagementPage(page: ManagementPage) {
	await openManagementTab(getManagementPageHash(page))
}

export async function openManagementSimulationStack(identifier?: TransactionOrMessageIdentifier) {
	await openManagementTab(getSimulationStackManagementHash(identifier))
}

export async function openManagementSimulationStackReview() {
	if (await getUseTabsInsteadOfPopup()) {
		await openManagementSimulationStack()
		return
	}
	await browser.windows.create({ url: `${ managementPagePath() }${ getManagementPageHash('simulation-stack') }` })
}

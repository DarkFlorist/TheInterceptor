import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getManagementPageHash, type ManagementPage } from '../utils/managementPages.js'
import { getSimulationStackManagementHash } from '../utils/simulationStackTargets.js'
import { openPopupOrTab } from '../utils/popupOrTab.js'
import { updateTabIfExists, updateWindowIfExists } from '../utils/requests.js'
import { getHtmlFile } from './backgroundUtils.js'
import { getManagementTabId, setManagementTabId } from './storageVariables.js'

function managementPagePath() {
	return getHtmlFile('settingsView')
}

async function openManagementTab(targetUrl: string): Promise<browser.tabs.Tab | undefined> {
	const pagePath = managementPagePath()
	const pageUrl = browser.runtime.getURL(pagePath)
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: targetUrl })
		if (tab.id !== undefined) await setManagementTabId(tab.id)
		return tab
	}

	const tabId = await getManagementTabId()
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const managementTab = allTabs.find((tab) => tab.id === tabId)

	if (managementTab?.id === undefined || (managementTab.url !== undefined && managementTab.url.split('#', 1)[0] !== pageUrl)) return await openInNewTab()
	const tab = await updateTabIfExists(managementTab.id, { active: true, highlighted: true, url: targetUrl })
	if (tab === undefined) return await openInNewTab()
	if (tab.windowId !== undefined) await updateWindowIfExists(tab.windowId, { focused: true })
	return tab
}

export async function openManagementPage(page: ManagementPage) {
	await openManagementTab(`${ managementPagePath() }${ getManagementPageHash(page) }`)
}

export async function openManagementSimulationStack(identifier?: TransactionOrMessageIdentifier) {
	await openManagementTab(`${ managementPagePath() }${ getSimulationStackManagementHash(identifier) }`)
}

export async function openManagementSimulationStackReview() {
	await openPopupOrTab({ url: `${ managementPagePath() }${ getManagementPageHash('simulation-stack') }` }, openManagementTab)
}

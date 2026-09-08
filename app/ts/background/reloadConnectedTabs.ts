import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getErrorMessage, reportUnexpectedError } from '../utils/errors.js'
import { checkAndThrowRuntimeLastError } from '../utils/requests.js'
import { getLastKnownCurrentTabId } from './currentTab.js'

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

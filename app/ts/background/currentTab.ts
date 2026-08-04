import { getCurrentTabId, saveCurrentTabId } from './storageVariables.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'

const isExtensionPageUrl = (urlString: string) => {
	if (urlString.startsWith('/html/') || urlString.startsWith('/html3/')) return true
	try {
		const url = new URL(urlString)
		const ownUrl = new URL(browser.runtime.getURL('/'))
		return url.protocol === ownUrl.protocol
	} catch {
		return false
	}
}

export async function getLastKnownCurrentTabId() {
	const tabIdPromise = getCurrentTabId()
	silenceChromeUnCaughtPromise(tabIdPromise)
	const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true })
	const tabId = await tabIdPromise
	// Skip restricted or insufficient-permission tabs.
	if (tabs[0]?.id === undefined || tabs[0]?.url === undefined) return tabId
	if (isExtensionPageUrl(tabs[0].url)) return tabId
	if (tabId !== tabs[0].id) await saveCurrentTabId(tabs[0].id)
	return tabs[0].id
}

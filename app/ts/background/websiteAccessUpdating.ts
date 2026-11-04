import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getInterceptorDisabledSites } from '../utils/contentScriptsUpdating.js'
import { updateWebsiteAccess } from './settings.js'

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites(previousWebsiteAccess))
	const nextDisabledSites = new Set(getInterceptorDisabledSites(nextWebsiteAccess))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

// Saves the change without updating the content script injection, so a caller can still reconcile the saved access when that update fails.
export async function updateWebsiteAccessAndDetectDisabledSitesChange(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	return disabledSitesChanged
}

import { reconcileContentScriptRegistration } from './contentScriptRegistration.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getInterceptorDisabledSites } from '../utils/contentScriptExclusions.js'
import { updateWebsiteAccess } from './settings.js'

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites(previousWebsiteAccess))
	const nextDisabledSites = new Set(getInterceptorDisabledSites(nextWebsiteAccess))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	return await reconcileContentScriptRegistration({ exclusionsChanged: disabledSitesChanged })
}

import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reloadConnectedTabs } from './reloadConnectedTabs.js'
import { reconcileContentScriptRegistration } from './contentScriptRegistration.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getInterceptorDisabledSites } from '../utils/contentScriptExclusions.js'
import { updateWebsiteAccess } from './settings.js'

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites(previousWebsiteAccess))
	const nextDisabledSites = new Set(getInterceptorDisabledSites(nextWebsiteAccess))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	const refreshed = await reconcileContentScriptRegistration({ exclusionsChanged: disabledSitesChanged })
	if (refreshed) await reloadConnectedTabs(websiteTabConnections)
	return refreshed

}

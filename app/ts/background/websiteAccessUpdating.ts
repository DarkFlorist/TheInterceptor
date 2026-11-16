import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getInterceptorDisabledSites, hasSameContentScriptInjectionSitesConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { reloadConnectedTabs } from './reloadConnectedTabs.js'
import { reconcileContentScriptRegistration } from './contentScriptRegistration.js'
import { runContentScriptConfigurationUpdate } from './contentScriptInjectionStrategy.js'
import { updateWebsiteAccessWithSnapshots } from './settings.js'

// Persist desired exclusions before registration. A failed browser update remains retryable without rolling back permissions or losing concurrent edits.
export async function updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	return await runContentScriptConfigurationUpdate(async () => {
		const { previousWebsiteAccess, updatedWebsiteAccess } = await updateWebsiteAccessWithSnapshots(update)
		const exclusionsChanged = !hasSameContentScriptInjectionSitesConfiguration({ interceptorDisabledSites: getInterceptorDisabledSites(previousWebsiteAccess) }, { interceptorDisabledSites: getInterceptorDisabledSites(updatedWebsiteAccess) })
		const refreshed = await reconcileContentScriptRegistration({ exclusionsChanged })
		if (refreshed) await reloadConnectedTabs(websiteTabConnections)
		return refreshed
	})
}

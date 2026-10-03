import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionConfigurationAndReloadTabsIfChanged } from './contentScriptInjectionStrategy.js'
import { updateWebsiteAccess } from './settings.js'

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		async () => await updateWebsiteAccess(update),
	)
}

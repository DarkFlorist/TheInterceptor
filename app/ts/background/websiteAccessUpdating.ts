import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionSitesAndReloadTabsIfChanged } from './contentScriptInjectionStrategy.js'
import { withWebsiteAccessRollback } from './settings.js'

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	await updateContentScriptInjectionSitesAndReloadTabsIfChanged(
		websiteTabConnections,
		update,
		withWebsiteAccessRollback,
	)
}

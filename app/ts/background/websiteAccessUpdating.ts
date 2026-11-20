import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { haveSameDisabledSites, updateContentScriptInjectionStrategy } from '../utils/contentScriptsUpdating.js'
import { updateWebsiteAccess } from './settings.js'

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	if (disabledSitesChanged) await updateContentScriptInjectionStrategy()
	return disabledSitesChanged
}

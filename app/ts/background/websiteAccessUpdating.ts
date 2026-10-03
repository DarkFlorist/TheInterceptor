import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { updateContentScriptInjectionStrategy } from '../utils/contentScriptsUpdating.js'
import { updateWebsiteAccess } from './settings.js'

const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

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
	if (disabledSitesChanged) await updateContentScriptInjectionStrategy()
	return disabledSitesChanged
}

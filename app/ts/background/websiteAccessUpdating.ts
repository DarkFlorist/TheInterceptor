import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { contentScriptRegistration, updateContentScriptInjectionStrategyManifestV2 } from './contentScriptRegistration.js'
import { getInterceptorDisabledSites, updateWebsiteAccess } from './settings.js'

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites({ websiteAccess: previousWebsiteAccess }))
	const nextDisabledSites = new Set(getInterceptorDisabledSites({ websiteAccess: nextWebsiteAccess }))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	if (disabledSitesChanged) {
		if (browser.runtime.getManifest().manifest_version === 3) await contentScriptRegistration.update()
		else await updateContentScriptInjectionStrategyManifestV2()
	}
	return disabledSitesChanged
}

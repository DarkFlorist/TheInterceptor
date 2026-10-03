import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'

export type ContentScriptInjectionConfiguration = {
	readonly metamaskCompatibilityMode: boolean
	readonly interceptorDisabledSites: readonly string[]
}

export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

export function hasSameContentScriptInjectionConfiguration(first: ContentScriptInjectionConfiguration, second: ContentScriptInjectionConfiguration) {
	if (first.metamaskCompatibilityMode !== second.metamaskCompatibilityMode) return false
	const firstDisabledSites = new Set(first.interceptorDisabledSites)
	const secondDisabledSites = new Set(second.interceptorDisabledSites)
	return firstDisabledSites.size === secondDisabledSites.size && [...firstDisabledSites].every((disabledSite) => secondDisabledSites.has(disabledSite))
}

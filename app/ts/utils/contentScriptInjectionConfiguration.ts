import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'

export type ContentScriptInjectionSitesConfiguration = {
	readonly interceptorDisabledSites: readonly string[]
}

export type PageWorldProviderConfiguration = {
	readonly metamaskCompatibilityMode: boolean
}

export type ContentScriptRegistrationConfiguration = {
	readonly injectionSites: ContentScriptInjectionSitesConfiguration
	readonly pageWorldProvider: PageWorldProviderConfiguration
}

export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

export function hasSameContentScriptInjectionSitesConfiguration(first: ContentScriptInjectionSitesConfiguration, second: ContentScriptInjectionSitesConfiguration) {
	const firstDisabledSites = new Set(first.interceptorDisabledSites)
	const secondDisabledSites = new Set(second.interceptorDisabledSites)
	return firstDisabledSites.size === secondDisabledSites.size && [...firstDisabledSites].every((disabledSite) => secondDisabledSites.has(disabledSite))
}

export function hasSamePageWorldProviderConfiguration(first: PageWorldProviderConfiguration, second: PageWorldProviderConfiguration) {
	return first.metamaskCompatibilityMode === second.metamaskCompatibilityMode
}

export function hasSameContentScriptRegistrationConfiguration(first: ContentScriptRegistrationConfiguration, second: ContentScriptRegistrationConfiguration) {
	return hasSameContentScriptInjectionSitesConfiguration(first.injectionSites, second.injectionSites) && hasSamePageWorldProviderConfiguration(first.pageWorldProvider, second.pageWorldProvider)
}

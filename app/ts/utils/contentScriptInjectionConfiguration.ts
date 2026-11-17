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

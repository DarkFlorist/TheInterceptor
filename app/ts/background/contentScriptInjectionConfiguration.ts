import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getInterceptorDisabledSites, hasSameContentScriptInjectionConfiguration, type ContentScriptInjectionConfiguration } from '../config/contentScriptInjectionConfiguration.js'
import { getMetamaskCompatibilityMode, getSettings, restoreContentScriptInjectionSettings } from './settings.js'

export type ContentScriptInjectionConfigurationSnapshot = ContentScriptInjectionConfiguration & {
	readonly websiteAccess: WebsiteAccessArray
}

export { getInterceptorDisabledSites, hasSameContentScriptInjectionConfiguration }

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptInjectionConfigurationSnapshot> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getSettings(), getMetamaskCompatibilityMode()])
	return { metamaskCompatibilityMode, interceptorDisabledSites: getInterceptorDisabledSites(settings.websiteAccess), websiteAccess: settings.websiteAccess }
}

export async function restoreContentScriptInjectionConfiguration(configuration: ContentScriptInjectionConfigurationSnapshot) {
	await restoreContentScriptInjectionSettings(configuration.metamaskCompatibilityMode, configuration.websiteAccess)
}

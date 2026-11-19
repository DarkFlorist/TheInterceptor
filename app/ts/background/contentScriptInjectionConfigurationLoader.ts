import { getInterceptorDisabledSites, type ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getMetamaskCompatibilityMode } from './settings.js'
import { getSettings } from './storedSettings.js'

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptRegistrationConfiguration> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getSettings(), getMetamaskCompatibilityMode()])
	return {
		injectionSites: { interceptorDisabledSites: getInterceptorDisabledSites(settings.websiteAccess) },
		pageWorldProvider: { metamaskCompatibilityMode },
	}
}

import { getInterceptorDisabledSites, type ContentScriptRegistrationConfiguration } from '../config/contentScriptInjectionConfiguration.js'
import { getMetamaskCompatibilityMode, getSettings } from './settings.js'

export { getInterceptorDisabledSites }

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptRegistrationConfiguration> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getSettings(), getMetamaskCompatibilityMode()])
	return {
		injectionSites: { interceptorDisabledSites: getInterceptorDisabledSites(settings.websiteAccess) },
		pageWorldProvider: { metamaskCompatibilityMode },
	}
}

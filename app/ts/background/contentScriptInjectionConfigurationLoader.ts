import { getInterceptorDisabledSites, type ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getMetamaskCompatibilityMode, getWebsiteApprovalsSnapshot, requireReadableApprovals } from './settings.js'

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptRegistrationConfiguration> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getWebsiteApprovalsSnapshot({ repairCorrupt: true }), getMetamaskCompatibilityMode()])
	return {
		injectionSites: { interceptorDisabledSites: getInterceptorDisabledSites(requireReadableApprovals(settings)) },
		pageWorldProvider: { metamaskCompatibilityMode },
	}
}

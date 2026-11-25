import { getInterceptorDisabledSites, type ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getMetamaskCompatibilityMode, getWebsiteApprovalsSnapshot } from './settings.js'
import { requireReadableApprovals } from './websiteAccessPolicy.js'

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptRegistrationConfiguration> {
	const [approvals, metamaskCompatibilityMode] = await Promise.all([getWebsiteApprovalsSnapshot({ repairCorrupt: true }), getMetamaskCompatibilityMode()])
	return {
		injectionSites: { interceptorDisabledSites: getInterceptorDisabledSites(requireReadableApprovals(approvals)) },
		pageWorldProvider: { metamaskCompatibilityMode },
	}
}

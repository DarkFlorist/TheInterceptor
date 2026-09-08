import { getInterceptorDisabledSites, getMetamaskCompatibilityMode, getSettings } from '../background/settings.js'

export type ContentScriptInjectionConfiguration = {
	readonly metamaskCompatibilityMode: boolean
	readonly interceptorDisabledSites: readonly string[]
}

export async function getContentScriptInjectionConfiguration(): Promise<ContentScriptInjectionConfiguration> {
	const [settings, metamaskCompatibilityMode] = await Promise.all([getSettings(), getMetamaskCompatibilityMode()])
	return { metamaskCompatibilityMode, interceptorDisabledSites: getInterceptorDisabledSites(settings) }
}

export function hasSameContentScriptInjectionConfiguration(first: ContentScriptInjectionConfiguration, second: ContentScriptInjectionConfiguration) {
	if (first.metamaskCompatibilityMode !== second.metamaskCompatibilityMode) return false
	const firstDisabledSites = new Set(first.interceptorDisabledSites)
	const secondDisabledSites = new Set(second.interceptorDisabledSites)
	return firstDisabledSites.size === secondDisabledSites.size && [...firstDisabledSites].every((disabledSite) => secondDisabledSites.has(disabledSite))
}

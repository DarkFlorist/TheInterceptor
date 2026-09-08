import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { persistMetamaskCompatibilityMode } from './settings.js'
import { refreshContentScriptInjectionStrategy } from './contentScriptInjectionStrategy.js'

export async function setMetamaskCompatibilityMode(websiteTabConnections: WebsiteTabConnections, metamaskCompatibilityMode: boolean) {
	await persistMetamaskCompatibilityMode(metamaskCompatibilityMode)
	await refreshContentScriptInjectionStrategy(websiteTabConnections)
}

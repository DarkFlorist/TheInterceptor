import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { persistMetamaskCompatibilityMode } from './settings.js'
import { refreshContentScriptInjectionStrategyAndReloadConnectedTabs } from './contentScriptInjectionStrategy.js'

export async function setMetamaskCompatibilityMode(websiteTabConnections: WebsiteTabConnections, metamaskCompatibilityMode: boolean) {
	await persistMetamaskCompatibilityMode(metamaskCompatibilityMode)
	await refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections)
}

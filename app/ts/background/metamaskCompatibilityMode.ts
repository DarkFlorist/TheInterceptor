import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { persistMetamaskCompatibilityMode } from './settings.js'
import { updateContentScriptInjectionConfigurationAndReloadTabsIfChanged } from './contentScriptInjectionStrategy.js'

export async function setMetamaskCompatibilityMode(websiteTabConnections: WebsiteTabConnections, metamaskCompatibilityMode: boolean) {
	await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections, async () => await persistMetamaskCompatibilityMode(metamaskCompatibilityMode))
}

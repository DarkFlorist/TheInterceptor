import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { persistMetamaskCompatibilityMode } from './settings.js'
import { updatePageWorldProviderBootstrapAfterSettingsChange } from './contentScriptInjectionStrategy.js'

export async function setMetamaskCompatibilityMode(websiteTabConnections: WebsiteTabConnections, metamaskCompatibilityMode: boolean) {
	await updatePageWorldProviderBootstrapAfterSettingsChange(websiteTabConnections, async () => await persistMetamaskCompatibilityMode(metamaskCompatibilityMode))
}

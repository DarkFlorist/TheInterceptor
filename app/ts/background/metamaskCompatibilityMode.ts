import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { persistMetamaskCompatibilityMode } from './settings.js'
import { reloadConnectedTabs } from './reloadConnectedTabs.js'

export async function setMetamaskCompatibilityMode(websiteTabConnections: WebsiteTabConnections, metamaskCompatibilityMode: boolean) {
	await persistMetamaskCompatibilityMode(metamaskCompatibilityMode)
	if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3()
	else await updateContentScriptInjectionStrategyManifestV2()
	await reloadConnectedTabs(websiteTabConnections)
}

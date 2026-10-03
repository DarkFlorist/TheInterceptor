import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { getContentScriptInjectionConfiguration, hasSameContentScriptInjectionConfiguration } from './contentScriptInjectionConfiguration.js'
import { reloadConnectedTabs } from './reloadConnectedTabs.js'

export async function refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections) {
	if (browser.runtime.getManifest().manifest_version === 3 && !await updateContentScriptInjectionStrategyManifestV3()) return
	if (browser.runtime.getManifest().manifest_version === 2) await updateContentScriptInjectionStrategyManifestV2()
	await reloadConnectedTabs(websiteTabConnections)
}

export async function updateContentScriptInjectionConfigurationAndReloadTabsIfChanged<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>) {
	const configurationBeforeUpdate = await getContentScriptInjectionConfiguration()
	const result = await update()
	const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
	if (!hasSameContentScriptInjectionConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) await refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections)
	return result
}

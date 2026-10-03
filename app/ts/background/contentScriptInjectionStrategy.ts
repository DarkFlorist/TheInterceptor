import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { getContentScriptInjectionConfiguration, hasSameContentScriptInjectionConfiguration, restoreContentScriptInjectionConfiguration, type ContentScriptInjectionConfigurationSnapshot } from './contentScriptInjectionConfiguration.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'

const contentScriptInjectionStrategySemaphore = new Semaphore(1)
const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

type ConfigurationUpdateTransaction = <T>(update: () => Promise<T>) => Promise<T>

async function runConfigurationUpdate<T>(update: () => Promise<T>) {
	return await update()
}

export async function refreshContentScriptInjectionStrategy(configuration?: ContentScriptInjectionConfigurationSnapshot) {
	await contentScriptInjectionStrategySemaphore.execute(async () => {
		const currentConfiguration = configuration ?? await getContentScriptInjectionConfiguration()
		if (browser.runtime.getManifest().manifest_version === 3) await updateContentScriptInjectionStrategyManifestV3(currentConfiguration)
		else await updateContentScriptInjectionStrategyManifestV2(getContentScriptInjectionConfiguration)
	})
}

export async function refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, configuration?: ContentScriptInjectionConfigurationSnapshot) {
	const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
	await refreshContentScriptInjectionStrategy(configuration)
	await reloadTabs(tabIdsToReload)
}

export async function updateContentScriptInjectionConfigurationAndReloadTabsIfChanged<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, transaction: ConfigurationUpdateTransaction = runConfigurationUpdate) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => await transaction(async () => {
		const configurationBeforeUpdate = await getContentScriptInjectionConfiguration()
		try {
			const result = await update()
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (hasSameContentScriptInjectionConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return result
			await refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
			return result
		} catch (error: unknown) {
			try {
				await restoreContentScriptInjectionConfiguration(configurationBeforeUpdate)
			} catch (rollbackError: unknown) {
				await reportUnexpectedError(rollbackError, { code: 'content_script_injection_settings_rollback_failed' })
			}
			throw error
		}
	}))
}

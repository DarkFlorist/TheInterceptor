import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { hasSameContentScriptInjectionSitesConfiguration, hasSameContentScriptRegistrationConfiguration, hasSamePageWorldProviderConfiguration, type ContentScriptRegistrationConfiguration } from '../config/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfiguration.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import { getMetamaskCompatibilityMode } from './settings.js'

const contentScriptInjectionStrategySemaphore = new Semaphore(1)
const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

type ConfigurationUpdateTransaction = <T>(update: () => Promise<T>) => Promise<T>
type HasSameConfiguration = (first: ContentScriptRegistrationConfiguration, second: ContentScriptRegistrationConfiguration) => boolean

async function runConfigurationUpdate<T>(update: () => Promise<T>) {
	return await update()
}

async function refreshContentScriptInjectionStrategyManifestV3(configuration: ContentScriptRegistrationConfiguration) {
	await contentScriptInjectionStrategySemaphore.execute(async () => {
		await updateContentScriptInjectionStrategyManifestV3(configuration)
	})
}

async function refreshContentScriptInjectionStrategyManifestV2() {
	await contentScriptInjectionStrategySemaphore.execute(async () => {
		await updateContentScriptInjectionStrategyManifestV2(getContentScriptInjectionConfiguration)
	})
}

export async function refreshContentScriptInjectionStrategy() {
	await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		if (browser.runtime.getManifest().manifest_version === 3) await refreshContentScriptInjectionStrategyManifestV3(await getContentScriptInjectionConfiguration())
		else await refreshContentScriptInjectionStrategyManifestV2()
	})
}

export async function refreshContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections) {
	const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
	await refreshContentScriptInjectionStrategy()
	await reloadTabs(tabIdsToReload)
}

async function refreshUpdatedContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, configuration: ContentScriptRegistrationConfiguration) {
	const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
	if (browser.runtime.getManifest().manifest_version === 3) await refreshContentScriptInjectionStrategyManifestV3(configuration)
	else await refreshContentScriptInjectionStrategyManifestV2()
	await reloadTabs(tabIdsToReload)
}

async function updateContentScriptInjectionConfigurationAndReloadTabsIfChanged<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, hasSameConfiguration: HasSameConfiguration, transaction: ConfigurationUpdateTransaction) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => await transaction(async () => {
		const configurationBeforeUpdate = await getContentScriptInjectionConfiguration()
		const result = await update()
		const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
		if (hasSameConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return result
		await refreshUpdatedContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
		return result
	}))
}

export async function updateContentScriptInjectionSitesAndReloadTabsIfChanged<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, transaction: ConfigurationUpdateTransaction) {
	return await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections, update, (first, second) => hasSameContentScriptInjectionSitesConfiguration(first.injectionSites, second.injectionSites), transaction)
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const pageWorldProviderBeforeUpdate = { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() }
		const result = await update()
		try {
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (!hasSamePageWorldProviderConfiguration(pageWorldProviderBeforeUpdate, configurationAfterUpdate.pageWorldProvider)) {
				await refreshUpdatedContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
			}
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'page_world_provider_bootstrap_refresh_failed' })
		}
		return result
	})
}

export async function updateAllContentScriptConfigurationAndReloadTabsIfChanged<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, transaction: ConfigurationUpdateTransaction = runConfigurationUpdate) {
	return await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections, update, hasSameContentScriptRegistrationConfiguration, transaction)
}

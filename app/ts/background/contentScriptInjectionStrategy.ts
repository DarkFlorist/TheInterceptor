import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { hasSameContentScriptInjectionSitesConfiguration, hasSameContentScriptRegistrationConfiguration, hasSamePageWorldProviderConfiguration, type ContentScriptRegistrationConfiguration } from '../config/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfiguration.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import { getMetamaskCompatibilityMode } from './settings.js'

const contentScriptInjectionStrategySemaphore = new Semaphore(1)
const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

type WebsiteAccessUpdateTransaction = (update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>) => Promise<WebsiteAccessArray>
type HasSameConfiguration = (first: ContentScriptRegistrationConfiguration, second: ContentScriptRegistrationConfiguration) => boolean

type ContentScriptInjectionStrategyRefresh =
	| { readonly configurationSource: 'storage' }
	| { readonly configurationSource: 'updated', readonly configuration: ContentScriptRegistrationConfiguration }

async function applyContentScriptInjectionStrategy(refresh: ContentScriptInjectionStrategyRefresh) {
	await contentScriptInjectionStrategySemaphore.execute(async () => {
		if (browser.runtime.getManifest().manifest_version === 2) {
			// MV2 installs a lazy reader because each navigation is injected through webNavigation.
			await updateContentScriptInjectionStrategyManifestV2(getContentScriptInjectionConfiguration)
			return
		}
		const configuration = refresh.configurationSource === 'storage' ? await getContentScriptInjectionConfiguration() : refresh.configuration
		await updateContentScriptInjectionStrategyManifestV3(configuration)
	})
}

export async function refreshContentScriptInjectionStrategy() {
	await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		await applyContentScriptInjectionStrategy({ configurationSource: 'storage' })
	})
}

async function refreshUpdatedContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, configuration: ContentScriptRegistrationConfiguration) {
	const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
	await applyContentScriptInjectionStrategy({ configurationSource: 'updated', configuration })
	await reloadTabs(tabIdsToReload)
}

async function refreshUpdatedPageWorldProviderBootstrapAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, configuration: ContentScriptRegistrationConfiguration) {
	// Persisted compatibility preference must reach MV3 registration even when optional tab discovery fails.
	await applyContentScriptInjectionStrategy({ configurationSource: 'updated', configuration })
	const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
	await reloadTabs(tabIdsToReload)
}

async function updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, hasSameConfiguration: HasSameConfiguration, transaction: WebsiteAccessUpdateTransaction) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const configurationBeforeUpdate = await getContentScriptInjectionConfiguration()
		return await transaction(update, async () => {
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (hasSameConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return
			await refreshUpdatedContentScriptInjectionStrategyAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
		})
	})
}

export async function updateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, transaction: WebsiteAccessUpdateTransaction) {
	return await updateContentScriptInjectionConfigurationAndReloadTabsIfChanged(websiteTabConnections, update, (first, second) => hasSameContentScriptInjectionSitesConfiguration(first.injectionSites, second.injectionSites), transaction)
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const pageWorldProviderBeforeUpdate = { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() }
		const result = await update()
		try {
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (!hasSamePageWorldProviderConfiguration(pageWorldProviderBeforeUpdate, configurationAfterUpdate.pageWorldProvider)) {
				await refreshUpdatedPageWorldProviderBootstrapAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
			}
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'page_world_provider_bootstrap_refresh_failed' })
		}
		return result
	})
}

export async function updateAllContentScriptConfigurationAfterSettingsImport<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, transaction: (update: () => Promise<T>) => Promise<T>) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const configurationBeforeUpdate = await getContentScriptInjectionConfiguration()
		const result = await transaction(update)
		try {
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (!hasSameContentScriptRegistrationConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) {
				await refreshUpdatedPageWorldProviderBootstrapAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate)
			}
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'settings_import_content_script_refresh_failed' })
		}
		return result
	})
}

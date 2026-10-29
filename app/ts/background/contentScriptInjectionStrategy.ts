import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { hasSameContentScriptInjectionSitesConfiguration, hasSameContentScriptRegistrationConfiguration, hasSamePageWorldProviderConfiguration, type ContentScriptRegistrationConfiguration } from '../config/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import { getMetamaskCompatibilityMode } from './settings.js'

const contentScriptInjectionStrategySemaphore = new Semaphore(1)
const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

type WebsiteAccessUpdateTransaction = (update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>) => Promise<WebsiteAccessArray>

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

type RefreshFailureHandling = 'rollBackUpdate' | 'reportAndKeepUpdate'

type ContentScriptConfigurationUpdate<Result> =
	| { readonly onRefreshFailure: 'rollBackUpdate', readonly runUpdateWithRefresh: (refreshIfChanged: () => Promise<void>) => Promise<Result> }
	| { readonly onRefreshFailure: 'reportAndKeepUpdate', readonly errorCode: string, readonly runUpdate: () => Promise<Result> }

async function applyConfigurationAndReloadConnectedTabs(websiteTabConnections: WebsiteTabConnections, configuration: ContentScriptRegistrationConfiguration, onRefreshFailure: RefreshFailureHandling) {
	// Rolled-back updates look up tabs before registering so a lookup failure leaves registration untouched; kept updates register first so the persisted change reaches MV3 registration even when optional tab lookup fails.
	if (onRefreshFailure === 'rollBackUpdate') {
		const tabIdsToReload = await getConnectedTabIdsToReload(websiteTabConnections)
		await applyContentScriptInjectionStrategy({ configurationSource: 'updated', configuration })
		await reloadTabs(tabIdsToReload)
		return
	}
	await applyContentScriptInjectionStrategy({ configurationSource: 'updated', configuration })
	await reloadTabs(await getConnectedTabIdsToReload(websiteTabConnections))
}

async function updateContentScriptConfigurationAndReloadTabsIfChanged<Snapshot, Result>(websiteTabConnections: WebsiteTabConnections, readConfigurationBeforeUpdate: () => Promise<Snapshot>, hasSameConfiguration: (before: Snapshot, after: ContentScriptRegistrationConfiguration) => boolean, update: ContentScriptConfigurationUpdate<Result>) {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const configurationBeforeUpdate = await readConfigurationBeforeUpdate()
		const refreshIfChanged = async () => {
			const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
			if (hasSameConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return
			await applyConfigurationAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate, update.onRefreshFailure)
		}
		if (update.onRefreshFailure === 'rollBackUpdate') return await update.runUpdateWithRefresh(refreshIfChanged)
		const result = await update.runUpdate()
		try {
			await refreshIfChanged()
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: update.errorCode })
		}
		return result
	})
}

export async function updateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, transaction: WebsiteAccessUpdateTransaction) {
	return await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		(before, after) => hasSameContentScriptInjectionSitesConfiguration(before.injectionSites, after.injectionSites),
		{ onRefreshFailure: 'rollBackUpdate', runUpdateWithRefresh: async (refreshIfChanged) => await transaction(update, refreshIfChanged) },
	)
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>) {
	return await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		async () => ({ metamaskCompatibilityMode: await getMetamaskCompatibilityMode() }),
		(before, after) => hasSamePageWorldProviderConfiguration(before, after.pageWorldProvider),
		{ onRefreshFailure: 'reportAndKeepUpdate', errorCode: 'page_world_provider_bootstrap_refresh_failed', runUpdate: update },
	)
}

export async function updateAllContentScriptConfigurationAfterSettingsImport<T>(websiteTabConnections: WebsiteTabConnections, update: () => Promise<T>, transaction: (update: () => Promise<T>) => Promise<T>) {
	return await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		hasSameContentScriptRegistrationConfiguration,
		{ onRefreshFailure: 'reportAndKeepUpdate', errorCode: 'settings_import_content_script_refresh_failed', runUpdate: async () => await transaction(update) },
	)
}

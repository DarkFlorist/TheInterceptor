import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { updateContentScriptInjectionStrategyManifestV2, updateContentScriptInjectionStrategyManifestV3 } from '../utils/contentScriptsUpdating.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { hasSameContentScriptInjectionSitesConfiguration, hasSameContentScriptRegistrationConfiguration, hasSamePageWorldProviderConfiguration, type ContentScriptRegistrationConfiguration } from '../utils/contentScriptInjectionConfiguration.js'
import { getContentScriptInjectionConfiguration } from './contentScriptInjectionConfigurationLoader.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import { getMetamaskCompatibilityMode } from './settings.js'

const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

type WebsiteAccessUpdateTransaction = (update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>) => Promise<WebsiteAccessArray>

type ContentScriptInjectionStrategyRefresh =
	| { readonly configurationSource: 'storage' }
	| { readonly configurationSource: 'updated', readonly configuration: ContentScriptRegistrationConfiguration }

// Callers must hold contentScriptInjectionConfigurationSemaphore, which serializes every registration update.
async function applyContentScriptInjectionStrategy(refresh: ContentScriptInjectionStrategyRefresh) {
	if (browser.runtime.getManifest().manifest_version === 2) {
		// MV2 installs a lazy reader because each navigation is injected through webNavigation.
		await updateContentScriptInjectionStrategyManifestV2(getContentScriptInjectionConfiguration)
		return
	}
	const configuration = refresh.configurationSource === 'storage' ? await getContentScriptInjectionConfiguration() : refresh.configuration
	await updateContentScriptInjectionStrategyManifestV3(configuration)
}

// Each exported entry point below is the one place that reports a refresh failure, once and with the code of its context; the scripting layer only throws.
export async function refreshContentScriptInjectionStrategy() {
	await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		try {
			await applyContentScriptInjectionStrategy({ configurationSource: 'storage' })
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: 'content_script_registration_failed' })
		}
	})
}

type RefreshFailureHandling = 'rollBackUpdate' | 'reportAndKeepUpdate'

type ContentScriptConfigurationUpdate =
	| { readonly onRefreshFailure: 'rollBackUpdate', readonly refreshFailureCode: string, readonly runUpdateWithRefresh: (refreshIfChanged: () => Promise<void>) => Promise<unknown> }
	| { readonly onRefreshFailure: 'reportAndKeepUpdate', readonly refreshFailureCode: string, readonly runUpdate: () => Promise<unknown> }

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

// A refresh failure is reported here and not rethrown: a kept update stays saved and a rolled-back one leaves storage as it was, and either way the popup re-reads storage. Failures of the update itself propagate unreported to the caller.
async function updateContentScriptConfigurationAndReloadTabsIfChanged<Snapshot>(websiteTabConnections: WebsiteTabConnections, readConfigurationBeforeUpdate: () => Promise<Snapshot>, hasSameConfiguration: (before: Snapshot, after: ContentScriptRegistrationConfiguration) => boolean, update: ContentScriptConfigurationUpdate) {
	await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		const configurationBeforeUpdate = await readConfigurationBeforeUpdate()
		const refreshErrors = new Set<unknown>()
		const refreshIfChanged = async () => {
			try {
				const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
				if (hasSameConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return
				await applyConfigurationAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate, update.onRefreshFailure)
			} catch (error: unknown) {
				refreshErrors.add(error)
				throw error
			}
		}
		try {
			if (update.onRefreshFailure === 'rollBackUpdate') {
				await update.runUpdateWithRefresh(refreshIfChanged)
			} else {
				await update.runUpdate()
				await refreshIfChanged()
			}
		} catch (error: unknown) {
			if (!refreshErrors.has(error)) throw error
			await reportUnexpectedError(error, { code: update.refreshFailureCode })
		}
	})
}

export async function updateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, transaction: WebsiteAccessUpdateTransaction) {
	await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		(before, after) => hasSameContentScriptInjectionSitesConfiguration(before.injectionSites, after.injectionSites),
		{ onRefreshFailure: 'rollBackUpdate', refreshFailureCode: 'website_access_content_script_refresh_failed', runUpdateWithRefresh: async (refreshIfChanged) => await transaction(update, refreshIfChanged) },
	)
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange(websiteTabConnections: WebsiteTabConnections, update: () => Promise<unknown>) {
	await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		async () => ({ metamaskCompatibilityMode: await getMetamaskCompatibilityMode() }),
		(before, after) => hasSamePageWorldProviderConfiguration(before, after.pageWorldProvider),
		{ onRefreshFailure: 'reportAndKeepUpdate', refreshFailureCode: 'page_world_provider_bootstrap_refresh_failed', runUpdate: update },
	)
}

export async function updateAllContentScriptConfigurationAfterSettingsImport(websiteTabConnections: WebsiteTabConnections, importSettings: () => Promise<unknown>) {
	await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		hasSameContentScriptRegistrationConfiguration,
		{ onRefreshFailure: 'reportAndKeepUpdate', refreshFailureCode: 'settings_import_content_script_refresh_failed', runUpdate: importSettings },
	)
}

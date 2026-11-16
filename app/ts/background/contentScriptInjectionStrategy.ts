import type { StorageTransactionOutcome } from './storageTransactionOutcome.js'
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

type WebsiteAccessUpdateTransaction = (update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>) => Promise<StorageTransactionOutcome>

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
	| { readonly onRefreshFailure: 'rollBackUpdate', readonly refreshFailureCode: string, readonly runUpdateWithRefresh: (refreshIfChanged: () => Promise<void>) => Promise<StorageTransactionOutcome> }
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

// Reload ownership is an outcome even when refresh/error reporting fails, so callers can finish their own post-commit work without an out-parameter.
export type ContentScriptConfigurationUpdateOutcome = {
	readonly reload: 'not-needed' | 'handled'
	readonly storage: 'not-written' | 'written' | 'rolled-back' | 'rollback-failed'
} & ({ readonly status: 'completed' } | { readonly status: 'failed', readonly error: unknown })

// Refresh failures are reported once here. Update failures and reporting failures are returned explicitly; website-access coordination needs the partial outcome to reconcile persisted permissions.
async function updateContentScriptConfigurationAndReloadTabsIfChanged<Snapshot>(websiteTabConnections: WebsiteTabConnections, readConfigurationBeforeUpdate: () => Promise<Snapshot>, hasSameConfiguration: (before: Snapshot, after: ContentScriptRegistrationConfiguration) => boolean, update: ContentScriptConfigurationUpdate): Promise<ContentScriptConfigurationUpdateOutcome> {
	return await contentScriptInjectionConfigurationSemaphore.execute(async () => {
		let reload: ContentScriptConfigurationUpdateOutcome['reload'] = 'not-needed'
		let storage: ContentScriptConfigurationUpdateOutcome['storage'] = 'not-written'
		try {
			const configurationBeforeUpdate = await readConfigurationBeforeUpdate()
			const refreshErrors = new Set<unknown>()
			const refreshIfChanged = async () => {
				try {
					const configurationAfterUpdate = await getContentScriptInjectionConfiguration()
					if (hasSameConfiguration(configurationBeforeUpdate, configurationAfterUpdate)) return
					// This layer owns the reload for a changed configuration, including failed attempts and rollback.
					reload = 'handled'
					await applyConfigurationAndReloadConnectedTabs(websiteTabConnections, configurationAfterUpdate, update.onRefreshFailure)
				} catch (error: unknown) {
					refreshErrors.add(error)
					throw error
				}
			}
			try {
				if (update.onRefreshFailure === 'rollBackUpdate') {
					const transaction = await update.runUpdateWithRefresh(refreshIfChanged)
					storage = transaction.storage
					if (transaction.status === 'failed') throw transaction.error
				} else {
					await update.runUpdate()
					storage = 'written'
					await refreshIfChanged()
				}
			} catch (error: unknown) {
				if (!refreshErrors.has(error)) throw error
				await reportUnexpectedError(error, { code: update.refreshFailureCode })
			}
			return { status: 'completed', reload, storage }
		} catch (error: unknown) {
			return { status: 'failed', reload, storage, error }
		}
	})
}

export async function tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, transaction: WebsiteAccessUpdateTransaction) {
	return await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		(before, after) => hasSameContentScriptInjectionSitesConfiguration(before.injectionSites, after.injectionSites),
		{ onRefreshFailure: 'rollBackUpdate', refreshFailureCode: 'website_access_content_script_refresh_failed', runUpdateWithRefresh: async (refreshIfChanged) => await transaction(update, refreshIfChanged) },
	)
}

// Ordinary configuration-update APIs throw on failures; only the explicitly named try variant exposes a partial outcome for website-access reconciliation.
export async function updateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, transaction: WebsiteAccessUpdateTransaction) {
	return requireCompletedConfigurationUpdate(await tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections, update, transaction))
}

// The other refresh workflows have no post-commit reconciliation and preserve their throwing API.
function requireCompletedConfigurationUpdate(outcome: ContentScriptConfigurationUpdateOutcome) {
	if (outcome.status === 'failed') throw outcome.error
	return outcome
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange(websiteTabConnections: WebsiteTabConnections, update: () => Promise<unknown>) {
	requireCompletedConfigurationUpdate(await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		async () => ({ metamaskCompatibilityMode: await getMetamaskCompatibilityMode() }),
		(before, after) => hasSamePageWorldProviderConfiguration(before, after.pageWorldProvider),
		{ onRefreshFailure: 'reportAndKeepUpdate', refreshFailureCode: 'page_world_provider_bootstrap_refresh_failed', runUpdate: update },
	))
}

export async function updateAllContentScriptConfigurationAfterSettingsImport(websiteTabConnections: WebsiteTabConnections, importSettings: () => Promise<unknown>) {
	requireCompletedConfigurationUpdate(await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		getContentScriptInjectionConfiguration,
		hasSameContentScriptRegistrationConfiguration,
		{ onRefreshFailure: 'reportAndKeepUpdate', refreshFailureCode: 'settings_import_content_script_refresh_failed', runUpdate: importSettings },
	))
}

import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reconcileContentScriptRegistration } from './contentScriptRegistration.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'

const contentScriptInjectionConfigurationSemaphore = new Semaphore(1)

// All configuration-changing workflows serialize their storage write, persisted-state reconciliation and reload here. The registration coordinator separately serializes browser mutations and retries at startup too.
export async function runContentScriptConfigurationUpdate<Result>(update: () => Promise<Result>): Promise<Result> {
	return await contentScriptInjectionConfigurationSemaphore.execute(update)
}

// A settings write stays saved if registration/reload fails; report that infrastructure failure once so an identical settings import can retry it. Storage failures propagate to the caller.
async function updateContentScriptConfigurationAndReloadTabsIfChanged(websiteTabConnections: WebsiteTabConnections, update: { readonly refreshFailureCode: string, readonly runUpdate: () => Promise<unknown> }) {
	await runContentScriptConfigurationUpdate(async () => {
		await update.runUpdate()
		try {
			// Repeating an import also retries an earlier failed registration when its desired settings already match storage.
			if (await reconcileContentScriptRegistration()) await reloadTabs(await getConnectedTabIdsToReload(websiteTabConnections))
		} catch (error: unknown) {
			await reportUnexpectedError(error, { code: update.refreshFailureCode })
		}
	})
}

export async function updatePageWorldProviderBootstrapAfterSettingsChange(websiteTabConnections: WebsiteTabConnections, update: () => Promise<unknown>) {
	await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		{ refreshFailureCode: 'page_world_provider_bootstrap_refresh_failed', runUpdate: update },
	)
}

export async function updateAllContentScriptConfigurationAfterSettingsImport(websiteTabConnections: WebsiteTabConnections, importSettings: () => Promise<unknown>) {
	await updateContentScriptConfigurationAndReloadTabsIfChanged(
		websiteTabConnections,
		{ refreshFailureCode: 'settings_import_content_script_refresh_failed', runUpdate: importSettings },
	)
}

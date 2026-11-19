import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged } from './contentScriptInjectionStrategy.js'
import { tryWebsiteAccessRollback } from './settingsTransactions.js'
import type { WebsiteAccessMutation } from './websiteAccessMutations.js'

// The canonical persistence/rollback and injection composition. Return partial outcomes so the workflow can reconcile saved or rolled-back permissions even when refresh/error reporting fails.
export async function tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: WebsiteAccessMutation) {
	return await tryUpdateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections, update, tryWebsiteAccessRollback)
}

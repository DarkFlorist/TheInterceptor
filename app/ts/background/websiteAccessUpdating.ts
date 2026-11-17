import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import { reconcileContentScriptRegistration } from './contentScriptRegistration.js'
import { runContentScriptConfigurationUpdate } from './contentScriptInjectionStrategy.js'
import { updateWebsiteAccess } from './settings.js'
import type { WebsiteAccessMutation } from './websiteAccessMutations.js'

type WebsiteAccessUpdateOutcome =
	| { readonly status: 'completed', readonly reload: 'not-needed' | 'handled', readonly storage: 'written' }
	| { readonly status: 'failed', readonly reload: 'not-needed' | 'handled' | 'blocked', readonly storage: 'not-written' | 'written', readonly error: unknown }

// Persist desired permissions before reconciling actual registrations. A failed browser update keeps the saved authority and is retried by the next reconciliation; the handler still reconciles open approvals.
export async function tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: WebsiteAccessMutation): Promise<WebsiteAccessUpdateOutcome> {
	return await runContentScriptConfigurationUpdate(async () => {
		try {
			await updateWebsiteAccess(update)
		} catch (error) {
			return { status: 'failed', reload: 'not-needed', storage: 'not-written', error }
		}
		let reload: 'not-needed' | 'handled' = 'not-needed'
		try {
			if (await reconcileContentScriptRegistration()) {
				reload = 'handled'
				await reloadTabs(await getConnectedTabIdsToReload(websiteTabConnections))
			}
			return { status: 'completed', reload, storage: 'written' }
		} catch (error) {
			return { status: 'failed', reload: reload === 'not-needed' ? 'blocked' : reload, storage: 'written', error }
		}
	})
}

import { getWebsiteAccess, getInterceptorDisabledSites } from './settings.js'
import { updateContentScriptInjectionStrategy } from '../utils/contentScriptsUpdating.js'
import { Semaphore } from '../utils/semaphore.js'

const registrationUpdates = new Semaphore(1)

// Explicit exclusion workflows await reconciliation before reload/success. Storage-only metadata and access edits never retry browser infrastructure work.
export async function reconcileContentScriptRegistration() {
	await registrationUpdates.execute(async () => {
		const disabledOrigins = getInterceptorDisabledSites({ websiteAccess: await getWebsiteAccess() })
		// Always read the persisted desired state; repeating a failed toggle/import/removal is sufficient to retry.
		await updateContentScriptInjectionStrategy(disabledOrigins)
	})
}

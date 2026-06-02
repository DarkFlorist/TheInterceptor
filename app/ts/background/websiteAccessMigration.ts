import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { normalizeHostnameScopedWebsiteAccess } from '../utils/websiteAccessScope.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

export async function migrateWebsiteAccess() {
	const storageEntries: Partial<Record<'websiteAccess', unknown>> = await browser.storage.local.get('websiteAccess')
	const rawWebsiteAccess = storageEntries.websiteAccess
	if (rawWebsiteAccess === undefined) return
	const parsedWebsiteAccess = WebsiteAccessArray.safeParse(rawWebsiteAccess)
	if (!parsedWebsiteAccess.success) return
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(parsedWebsiteAccess.value)
	const normalizedWebsiteAccess = normalizeHostnameScopedWebsiteAccess(sanitizedWebsiteAccess)
	if (sanitizedWebsiteAccess === parsedWebsiteAccess.value && !normalizedWebsiteAccess.changed) return
	await browserStorageLocalSet({
		websiteAccess: normalizedWebsiteAccess.websiteAccess,
	})
}

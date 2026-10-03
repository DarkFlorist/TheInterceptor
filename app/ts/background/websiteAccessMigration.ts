import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

export async function migrateWebsiteAccess() {
	const storageEntries: Partial<Record<'websiteAccess', unknown>> = await browser.storage.local.get('websiteAccess')
	const rawWebsiteAccess = storageEntries.websiteAccess
	if (rawWebsiteAccess === undefined) return
	const parsedWebsiteAccess = WebsiteAccessArray.safeParse(rawWebsiteAccess)
	if (!parsedWebsiteAccess.success) return
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(parsedWebsiteAccess.value)
	if (sanitizedWebsiteAccess === parsedWebsiteAccess.value) return
	await browserStorageLocalSet({ websiteAccess: sanitizedWebsiteAccess })
}

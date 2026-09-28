import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import { getWebsiteOrigin } from '../utils/websiteOrigin.js'

export function migrateWebsiteAccessOrigins(entries: WebsiteAccessArray): WebsiteAccessArray {
	const explicitOrigins = new Set(entries.map((entry) => getWebsiteOrigin(entry.website.websiteOrigin)).filter((origin) => origin !== undefined))
	const canonicalOrigins = new Set(entries.filter((entry) => getWebsiteOrigin(entry.website.websiteOrigin) === entry.website.websiteOrigin).map((entry) => entry.website.websiteOrigin))
	let changed = false
	const migrated = entries.flatMap((entry) => {
		const origin = entry.website.websiteOrigin
		if (getWebsiteOrigin(origin) === origin) return [entry]
		changed = true
		const explicitDestination = getWebsiteOrigin(origin)
		if (explicitDestination !== undefined) {
			// Canonical entries take precedence over aliases; otherwise preserve all permissions for the same unambiguous origin.
			if (canonicalOrigins.has(explicitDestination)) return []
			canonicalOrigins.add(explicitDestination)
			return [{ ...entry, website: { ...entry.website, websiteOrigin: explicitDestination } }]
		}
		const destination = getWebsiteOrigin(`https://${ origin }`)
		if (origin === '' || origin.includes('://') || destination === undefined || explicitOrigins.has(destination)) return []
		explicitOrigins.add(destination)
		// The old hostname key does not tell us which scheme was approved. Keep its metadata but require fresh consent, including for disabling interception.
		return [{ ...entry, website: { ...entry.website, websiteOrigin: destination }, access: undefined, addressAccess: undefined, interceptorDisabled: undefined }]
	})
	return changed ? migrated : entries
}

export async function migrateWebsiteAccess() {
	const storageEntries: Partial<Record<'websiteAccess', unknown>> = await browser.storage.local.get('websiteAccess')
	const rawWebsiteAccess = storageEntries.websiteAccess
	if (rawWebsiteAccess === undefined) return
	const parsedWebsiteAccess = WebsiteAccessArray.safeParse(rawWebsiteAccess)
	if (!parsedWebsiteAccess.success) return
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(migrateWebsiteAccessOrigins(parsedWebsiteAccess.value))
	if (sanitizedWebsiteAccess === parsedWebsiteAccess.value) return
	await browserStorageLocalSet({ websiteAccess: sanitizedWebsiteAccess })
}

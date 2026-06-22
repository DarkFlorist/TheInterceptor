import { WebsiteAccessArray, type WebsiteAccess } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { getSchemefulOriginsForLegacyWebsiteOrigin, isSchemefulWebsiteOrigin, normalizeSchemefulWebsiteOrigin } from '../utils/requests.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

export function migrateWebsiteAccessOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const exactSchemefulOrigins = new Set(
		websiteAccess
			.filter((entry) => isSchemefulWebsiteOrigin(entry.website.websiteOrigin))
			.map((entry) => normalizeSchemefulWebsiteOrigin(entry.website.websiteOrigin))
	)
	const migratedWebsiteAccess: WebsiteAccess[] = []
	const seenWebsiteOrigins = new Set<string>()

	const addEntry = (entry: WebsiteAccess, websiteOrigin: string) => {
		if (seenWebsiteOrigins.has(websiteOrigin)) {
			changed = true
			return
		}
		seenWebsiteOrigins.add(websiteOrigin)
		if (entry.website.websiteOrigin === websiteOrigin) {
			migratedWebsiteAccess.push(entry)
			return
		}
		changed = true
		migratedWebsiteAccess.push({
			...entry,
			website: {
				...entry.website,
				websiteOrigin,
			}
		})
	}

	for (const entry of websiteAccess) {
		const storedWebsiteOrigin = entry.website.websiteOrigin
		if (isSchemefulWebsiteOrigin(storedWebsiteOrigin)) {
			addEntry(entry, normalizeSchemefulWebsiteOrigin(storedWebsiteOrigin))
			continue
		}
		for (const websiteOrigin of getSchemefulOriginsForLegacyWebsiteOrigin(storedWebsiteOrigin)) {
			if (exactSchemefulOrigins.has(websiteOrigin)) {
				changed = true
				continue
			}
			addEntry(entry, websiteOrigin)
		}
	}

	return changed ? migratedWebsiteAccess : websiteAccess
}

export async function migrateWebsiteAccess() {
	const storageEntries: Partial<Record<'websiteAccess', unknown>> = await browser.storage.local.get('websiteAccess')
	const rawWebsiteAccess = storageEntries.websiteAccess
	if (rawWebsiteAccess === undefined) return
	const parsedWebsiteAccess = WebsiteAccessArray.safeParse(rawWebsiteAccess)
	if (!parsedWebsiteAccess.success) return
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(parsedWebsiteAccess.value)
	const migratedWebsiteAccess = migrateWebsiteAccessOrigins(sanitizedWebsiteAccess)
	if (migratedWebsiteAccess === parsedWebsiteAccess.value) return
	await browserStorageLocalSet({ websiteAccess: migratedWebsiteAccess })
}

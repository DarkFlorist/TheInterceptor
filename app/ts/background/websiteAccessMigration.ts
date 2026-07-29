import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import { getWebsiteOrigin } from '../utils/requests.js'

const isLegacyHttpDevelopmentHost = (hostname: string) => {
	return hostname === 'localhost'
		|| hostname === '127.0.0.1'
		|| hostname === '[::1]'
		|| hostname.endsWith('.test')
}

export function normalizeStoredWebsiteOrigin(websiteOrigin: string): string {
	if (/^(?:file|https?):\/\//iu.test(websiteOrigin)) {
		return getWebsiteOrigin(websiteOrigin)
	}
	try {
		const legacyUrl = new URL(`https://${ websiteOrigin }`)
		const protocol = isLegacyHttpDevelopmentHost(legacyUrl.hostname) ? 'http:' : 'https:'
		return getWebsiteOrigin(`${ protocol }//${ legacyUrl.host }`)
	} catch {
		return websiteOrigin
	}
}

export function normalizeWebsiteAccessOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const normalized = websiteAccess.map((entry) => {
		const websiteOrigin = normalizeStoredWebsiteOrigin(entry.website.websiteOrigin)
		if (websiteOrigin === entry.website.websiteOrigin) return entry
		changed = true
		return { ...entry, website: { ...entry.website, websiteOrigin } }
	})
	return changed ? normalized : websiteAccess
}

export async function migrateWebsiteAccess() {
	const storageEntries: Partial<Record<'websiteAccess', unknown>> = await browser.storage.local.get('websiteAccess')
	const rawWebsiteAccess = storageEntries.websiteAccess
	if (rawWebsiteAccess === undefined) return
	const parsedWebsiteAccess = WebsiteAccessArray.safeParse(rawWebsiteAccess)
	if (!parsedWebsiteAccess.success) return
	const sanitizedWebsiteAccess = normalizeWebsiteAccessOrigins(sanitizeWebsiteAccess(parsedWebsiteAccess.value))
	if (sanitizedWebsiteAccess === parsedWebsiteAccess.value) return
	await browserStorageLocalSet({ websiteAccess: sanitizedWebsiteAccess })
}

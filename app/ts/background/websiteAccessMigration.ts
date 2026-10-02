import { WebsiteAccessArray, type WebsiteAccess, type WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'
import { getWebsiteOrigin } from '../utils/websiteOrigin.js'

// These records name the same origin. Preserve distinct grants and safety settings; explicit denials win conflicts rather than silently broadening access.
function mergeOriginPermissions(previous: WebsiteAccess, incoming: WebsiteAccess): WebsiteAccess {
	const addressAccess = new Map<bigint, WebsiteAddressAccess>()
	for (const entry of [...(previous.addressAccess ?? []), ...(incoming.addressAccess ?? [])]) {
		const existing = addressAccess.get(entry.address)
		addressAccess.set(entry.address, { ...entry, access: existing?.access === false ? false : entry.access })
	}
	return {
		website: { ...previous.website, icon: previous.website.icon ?? incoming.website.icon, title: previous.website.title ?? incoming.website.title },
		access: previous.access === false || incoming.access === false ? false : previous.access ?? incoming.access,
		addressAccess: previous.addressAccess === undefined && incoming.addressAccess === undefined ? undefined : [...addressAccess.values()],
		interceptorDisabled: previous.interceptorDisabled === false || incoming.interceptorDisabled === false ? false : previous.interceptorDisabled ?? incoming.interceptorDisabled,
		declarativeNetRequestBlockMode: previous.declarativeNetRequestBlockMode === 'block-all' || incoming.declarativeNetRequestBlockMode === 'block-all' ? 'block-all' : previous.declarativeNetRequestBlockMode ?? incoming.declarativeNetRequestBlockMode,
	}
}

export function migrateWebsiteAccessOrigins(entries: WebsiteAccessArray): WebsiteAccessArray {
	const explicitOrigins = new Set(entries.map((entry) => getWebsiteOrigin(entry.website.websiteOrigin)).filter((origin) => origin !== undefined))
	const canonicalOrigins = new Set(entries.filter((entry) => getWebsiteOrigin(entry.website.websiteOrigin) === entry.website.websiteOrigin).map((entry) => entry.website.websiteOrigin))
	const migrated = new Map<string, WebsiteAccess>()
	let changed = false
	for (const entry of entries) {
		const origin = entry.website.websiteOrigin
		const explicitDestination = getWebsiteOrigin(origin)
		if (explicitDestination === origin) {
			const previous = migrated.get(origin)
			if (previous !== undefined) changed = true
			migrated.set(origin, previous === undefined ? entry : mergeOriginPermissions(previous, entry))
			continue
		}
		changed = true
		if (explicitDestination !== undefined) {
			// An existing canonical record remains authoritative; aliases without one are merged, not discarded.
			if (canonicalOrigins.has(explicitDestination)) continue
			const canonicalEntry = { ...entry, website: { ...entry.website, websiteOrigin: explicitDestination } }
			const previous = migrated.get(explicitDestination)
			migrated.set(explicitDestination, previous === undefined ? canonicalEntry : mergeOriginPermissions(previous, canonicalEntry))
			continue
		}
		const destination = getWebsiteOrigin(`https://${ origin }`)
		if (origin === '' || origin.includes('://') || destination === undefined || explicitOrigins.has(destination)) continue
		explicitOrigins.add(destination)
		// The old hostname key does not tell us which scheme was approved. Keep its metadata but require fresh consent, including for disabling interception.
		migrated.set(destination, { ...entry, website: { ...entry.website, websiteOrigin: destination }, access: undefined, addressAccess: undefined, interceptorDisabled: undefined })
	}
	return changed ? [...migrated.values()] : entries
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

import { WebsiteAccessArray, type WebsiteAccess, type WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { getSchemefulOriginsForLegacyWebsiteOrigin, isSchemefulWebsiteOrigin, normalizeSchemefulWebsiteOrigin } from '../utils/requests.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

const mergeAccessFlag = (first: boolean | undefined, second: boolean | undefined): boolean | undefined => {
	if (first === false || second === false) return false
	if (first === true || second === true) return true
	return undefined
}

const mergeAddressAccess = (first: readonly WebsiteAddressAccess[] | undefined, second: readonly WebsiteAddressAccess[] | undefined): readonly WebsiteAddressAccess[] | undefined => {
	if (first === undefined) return second
	if (second === undefined) return first
	const byAddress = new Map<bigint, WebsiteAddressAccess>()
	for (const addressAccess of first.concat(second)) {
		const previousAccess = byAddress.get(addressAccess.address)
		if (previousAccess === undefined) {
			byAddress.set(addressAccess.address, addressAccess)
			continue
		}
		byAddress.set(addressAccess.address, {
			address: addressAccess.address,
			access: previousAccess.access && addressAccess.access,
		})
	}
	return [...byAddress.values()]
}

const mergeBlockMode = (first: WebsiteAccess['declarativeNetRequestBlockMode'], second: WebsiteAccess['declarativeNetRequestBlockMode']): WebsiteAccess['declarativeNetRequestBlockMode'] => {
	if (first === 'block-all' || second === 'block-all') return 'block-all'
	if (first === 'disabled' || second === 'disabled') return 'disabled'
	return undefined
}

const mergeWebsiteAccess = (first: WebsiteAccess, second: WebsiteAccess): WebsiteAccess => {
	const access = mergeAccessFlag(first.access, second.access)
	const interceptorDisabled = first.interceptorDisabled === true || second.interceptorDisabled === true ? true : undefined
	const declarativeNetRequestBlockMode = mergeBlockMode(first.declarativeNetRequestBlockMode, second.declarativeNetRequestBlockMode)
	return {
		website: mergeStoredWebsiteMetadata(first.website, second.website),
		addressAccess: mergeAddressAccess(first.addressAccess, second.addressAccess),
		...access === undefined ? {} : { access },
		...interceptorDisabled === undefined ? {} : { interceptorDisabled },
		...declarativeNetRequestBlockMode === undefined ? {} : { declarativeNetRequestBlockMode },
	}
}

export function migrateWebsiteAccessOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const exactSchemefulOrigins = new Set(
		websiteAccess
			.filter((entry) => isSchemefulWebsiteOrigin(entry.website.websiteOrigin))
			.map((entry) => normalizeSchemefulWebsiteOrigin(entry.website.websiteOrigin))
	)
	const migratedWebsiteAccess: WebsiteAccess[] = []
	const seenWebsiteOrigins = new Map<string, number>()

	const addEntry = (entry: WebsiteAccess, websiteOrigin: string) => {
		const previousIndex = seenWebsiteOrigins.get(websiteOrigin)
		if (previousIndex !== undefined) {
			const previousEntry = migratedWebsiteAccess[previousIndex]
			if (previousEntry === undefined) throw new Error('seen website origin was missing from migrated access list')
			migratedWebsiteAccess[previousIndex] = mergeWebsiteAccess(previousEntry, {
				...entry,
				website: { ...entry.website, websiteOrigin },
			})
			changed = true
			return
		}
		seenWebsiteOrigins.set(websiteOrigin, migratedWebsiteAccess.length)
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

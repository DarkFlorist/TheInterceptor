import type { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from './websiteIcons.js'
import { normalizeWebsiteAccessOrigins } from './websiteOrigin.js'

function mergeAddressAccesses(first: WebsiteAccess['addressAccess'], second: WebsiteAccess['addressAccess']): WebsiteAccess['addressAccess'] {
	if (first === undefined) return second
	if (second === undefined) return first
	const merged = new Map<bigint, WebsiteAddressAccess>()
	for (const addressAccess of [...first, ...second]) {
		const previous = merged.get(addressAccess.address)
		merged.set(addressAccess.address, previous === undefined ? addressAccess : { address: addressAccess.address, access: previous.access && addressAccess.access })
	}
	return [...merged.values()]
}

const mergeRestrictiveFlag = (first: boolean | undefined, second: boolean | undefined, restrictiveValue: boolean) => {
	if (first === restrictiveValue || second === restrictiveValue) return restrictiveValue
	return first ?? second
}

// Two records for one origin are merged so that the more restrictive decision wins on each field: a denial over a grant, a disabled Interceptor over an enabled one, and blocking over not blocking. Every reader then sees at most one record per origin, so lookups that take the first match and lookups that take any match agree.
function mergeWebsiteAccessEntries(first: WebsiteAccess, second: WebsiteAccess): WebsiteAccess {
	const access = mergeRestrictiveFlag(first.access, second.access, false)
	const interceptorDisabled = mergeRestrictiveFlag(first.interceptorDisabled, second.interceptorDisabled, true)
	const declarativeNetRequestBlockMode = first.declarativeNetRequestBlockMode === 'block-all' || second.declarativeNetRequestBlockMode === 'block-all'
		? 'block-all'
		: first.declarativeNetRequestBlockMode ?? second.declarativeNetRequestBlockMode
	return {
		website: mergeStoredWebsiteMetadata(first.website, second.website),
		addressAccess: mergeAddressAccesses(first.addressAccess, second.addressAccess),
		...access === undefined ? {} : { access },
		...interceptorDisabled === undefined ? {} : { interceptorDisabled },
		...declarativeNetRequestBlockMode === undefined ? {} : { declarativeNetRequestBlockMode },
	}
}

function mergeDuplicateWebsiteOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	const entriesByOrigin = new Map<string, WebsiteAccess>()
	for (const entry of websiteAccess) {
		const previous = entriesByOrigin.get(entry.website.websiteOrigin)
		entriesByOrigin.set(entry.website.websiteOrigin, previous === undefined ? entry : mergeWebsiteAccessEntries(previous, entry))
	}
	return entriesByOrigin.size === websiteAccess.length ? websiteAccess : [...entriesByOrigin.values()]
}

// The single producer of the website access that storage readers, writers and the startup migration see: icons sanitized, origins in canonical form and one record per origin. It returns its input unchanged when it is already canonical, so callers can detect whether storage needs rewriting.
export function toCanonicalWebsiteAccess(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	return mergeDuplicateWebsiteOrigins(normalizeWebsiteAccessOrigins(sanitizeWebsiteAccess(websiteAccess)))
}

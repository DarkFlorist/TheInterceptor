import type { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from './websiteIcons.js'
import { normalizeStoredWebsiteOrigin } from './websiteOrigin.js'

function normalizeWebsiteAccessOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const normalized = websiteAccess.flatMap((entry) => {
		const websiteOrigin = normalizeStoredWebsiteOrigin(entry.website.websiteOrigin)
		if (websiteOrigin === undefined) {
			changed = true
			return []
		}
		if (websiteOrigin === entry.website.websiteOrigin) return [entry]
		changed = true
		return [{ ...entry, website: { ...entry.website, websiteOrigin } }]
	})
	return changed ? normalized : websiteAccess
}

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

// How two records for one origin combine on each field, the more restrictive decision winning: a denial over a grant, a disabled Interceptor over an enabled one, and blocking over not blocking. The mapped type names every WebsiteAccess field, so a new field fails to compile until it gets a rule here.
const websiteAccessMergeRules: { readonly [Field in keyof WebsiteAccess]-?: (first: WebsiteAccess[Field], second: WebsiteAccess[Field]) => WebsiteAccess[Field] } = {
	website: mergeStoredWebsiteMetadata,
	addressAccess: mergeAddressAccesses,
	access: (first, second) => mergeRestrictiveFlag(first, second, false),
	interceptorDisabled: (first, second) => mergeRestrictiveFlag(first, second, true),
	declarativeNetRequestBlockMode: (first, second) => first === 'block-all' || second === 'block-all' ? 'block-all' : first ?? second,
}

// Every reader then sees at most one record per origin, so lookups that take the first match and lookups that take any match agree. The spread keeps any field the rules do not know, such as one stored by a newer release, with the later record's value.
function mergeWebsiteAccessEntries(first: WebsiteAccess, second: WebsiteAccess): WebsiteAccess {
	const access = websiteAccessMergeRules.access(first.access, second.access)
	const interceptorDisabled = websiteAccessMergeRules.interceptorDisabled(first.interceptorDisabled, second.interceptorDisabled)
	const declarativeNetRequestBlockMode = websiteAccessMergeRules.declarativeNetRequestBlockMode(first.declarativeNetRequestBlockMode, second.declarativeNetRequestBlockMode)
	return {
		...first,
		...second,
		website: websiteAccessMergeRules.website(first.website, second.website),
		addressAccess: websiteAccessMergeRules.addressAccess(first.addressAccess, second.addressAccess),
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

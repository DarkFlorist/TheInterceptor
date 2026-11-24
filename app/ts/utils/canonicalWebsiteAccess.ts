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

// A rule per field of a record type, saying how that field of two records combines into one.
export type FieldMergeRules<RecordType extends object> = { readonly [Field in keyof RecordType]-?: (first: RecordType[Field], second: RecordType[Field]) => RecordType[Field] }

// Object.keys of a rule table, typed by the table's own keys.
const getRuleFields = <RecordType extends object>(rules: FieldMergeRules<RecordType>) => Object.keys(rules).filter((field): field is Extract<keyof RecordType, string> => field in rules)

function applyFieldMergeRule<RecordType extends object, Field extends keyof RecordType>(merged: { -readonly [Key in keyof RecordType]: RecordType[Key] }, rules: FieldMergeRules<RecordType>, field: Field, first: RecordType, second: RecordType) {
	merged[field] = rules[field](first[field], second[field])
}

// Merges two records by applying every rule in the table, so adding a rule is all it takes for a field to merge by it. The spread of both records is only the base for fields the table does not know, such as one stored by a newer release, which keep the later record's value.
export function mergeRecordsByFieldRules<RecordType extends object>(rules: FieldMergeRules<RecordType>, first: RecordType, second: RecordType): RecordType {
	const merged: { -readonly [Key in keyof RecordType]: RecordType[Key] } = { ...first, ...second }
	for (const field of getRuleFields(rules)) applyFieldMergeRule(merged, rules, field, first, second)
	return merged
}

// How two records for one origin combine on each field, the more restrictive decision winning: a denial over a grant, a disabled Interceptor over an enabled one, and blocking over not blocking. The mapped type names every WebsiteAccess field, so a new field fails to compile until it gets a rule here, and mergeRecordsByFieldRules then applies it.
export const websiteAccessMergeRules: FieldMergeRules<WebsiteAccess> = {
	website: mergeStoredWebsiteMetadata,
	addressAccess: mergeAddressAccesses,
	access: (first, second) => mergeRestrictiveFlag(first, second, false),
	interceptorDisabled: (first, second) => mergeRestrictiveFlag(first, second, true),
	declarativeNetRequestBlockMode: (first, second) => first === 'block-all' || second === 'block-all' ? 'block-all' : first ?? second,
}

// Every reader then sees at most one record per origin, so lookups that take the first match and lookups that take any match agree.
const mergeWebsiteAccessEntries = (first: WebsiteAccess, second: WebsiteAccess) => mergeRecordsByFieldRules(websiteAccessMergeRules, first, second)

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

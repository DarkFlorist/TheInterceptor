import { assertNever } from '../utils/typescript.js'
import type { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'

// Pure website-access field semantics shared by authority reconciliation and transactional rollback. Storage orchestration does not decide which fields grant access. Equality, and for transaction-rolled-back types also rollback, for every field of a stored type; the mapped types make a field added to that type without a rule here a compile error.
type FieldEquality<T> = { readonly [Key in keyof T]-?: { readonly isSame: (first: T[Key], second: T[Key]) => boolean } }
type FieldRules<T> = { readonly [Key in keyof T]-?: FieldEquality<T>[Key] & { readonly rollback: (previous: T[Key] | undefined, updated: T[Key], current: T[Key]) => T[Key] } }

function hasSameFields<T extends object>(fields: FieldEquality<T>, first: T, second: T) {
	for (const key in fields) {
		if (!fields[key].isSame(first[key], second[key])) return false
	}
	return true
}

// Fields rolled back to absent are written as undefined, which persists the same as omitting them.
function rollbackFields<T extends object>(rules: FieldRules<T>, previous: T | undefined, updated: T, current: T): T {
	const restored = { ...current }
	for (const key in rules) restored[key] = rules[key].rollback(previous?.[key], updated[key], current[key])
	return restored
}

// Reverts a value the transaction changed unless a concurrent writer has overwritten it since.
function revertUnlessOverwritten<Value>(isSame: (first: Value | undefined, second: Value | undefined) => boolean) {
	return {
		isSame,
		rollback: (previous: Value | undefined, updated: Value | undefined, current: Value | undefined) => !isSame(previous, updated) && isSame(current, updated) ? previous : current,
	}
}

const addressAccessEntryEquality = {
	address: { isSame: Object.is },
	access: { isSame: Object.is },
} satisfies FieldEquality<WebsiteAddressAccess>

function hasSameAddressAccess(first: readonly WebsiteAddressAccess[] | undefined, second: readonly WebsiteAddressAccess[] | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((entry, index) => {
		const secondEntry = second[index]
		return secondEntry !== undefined && hasSameFields(addressAccessEntryEquality, entry, secondEntry)
	})
}

const websiteRules = {
	// The origin identifies the entry, so rollback never changes it.
	websiteOrigin: { isSame: Object.is, rollback: (_previous, _updated, current) => current },
	title: revertUnlessOverwritten<string>(Object.is),
	icon: revertUnlessOverwritten<string>(Object.is),
} satisfies FieldRules<Website>

type WebsiteAccessRules = { readonly [Key in keyof WebsiteAccess]-?: FieldRules<WebsiteAccess>[Key] & { readonly affectsApproval: boolean } }
const websiteAccessRules = {
	website: {
		affectsApproval: false,
		isSame: (first, second) => hasSameFields(websiteRules, first, second),
		rollback: (previous, updated, current) => rollbackFields(websiteRules, previous, updated, current),
	},
	addressAccess: { ...revertUnlessOverwritten(hasSameAddressAccess), affectsApproval: true },
	access: { ...revertUnlessOverwritten<boolean>(Object.is), affectsApproval: true },
	interceptorDisabled: { ...revertUnlessOverwritten<boolean>(Object.is), affectsApproval: true },
	declarativeNetRequestBlockMode: { ...revertUnlessOverwritten<WebsiteAccess['declarativeNetRequestBlockMode']>(Object.is), affectsApproval: false },
} satisfies WebsiteAccessRules

// Approval comparison shares the exhaustive field rules with rollback. A future persisted field must explicitly declare whether it carries authority.
function hasSameApprovalFields<T extends object>(rules: { readonly [Key in keyof T]-?: FieldEquality<T>[Key] & { readonly affectsApproval: boolean } }, first: T, second: T) {
	for (const key in rules) {
		if (rules[key].affectsApproval && !rules[key].isSame(first[key], second[key])) return false
	}
	return true
}

function hasSameWebsiteApproval(first: WebsiteAccess, second: WebsiteAccess) {
	const normalize = (entry: WebsiteAccess): WebsiteAccess => ({ ...entry, addressAccess: entry.addressAccess?.length === 0 ? undefined : entry.addressAccess, interceptorDisabled: entry.interceptorDisabled === true ? true : undefined })
	return hasSameApprovalFields(websiteAccessRules, normalize(first), normalize(second))
}

export function getWebsiteApprovalChangedOrigins(previous: WebsiteAccessArray, next: WebsiteAccessArray): readonly string[] {
	const groupByOrigin = (entries: WebsiteAccessArray) => {
		const groups = new Map<string, WebsiteAccess[]>()
		for (const entry of entries) groups.set(entry.website.websiteOrigin, [...(groups.get(entry.website.websiteOrigin) ?? []), entry])
		// A single metadata/block-only row grants no more authority than an absent row. Keep duplicate ordering for legacy lookup precedence.
		for (const [origin, entries] of groups) {
			if (entries.length === 1 && entries[0] !== undefined && hasSameWebsiteApproval(entries[0], { website: entries[0].website, addressAccess: undefined })) groups.delete(origin)
		}
		return groups
	}
	const before = groupByOrigin(previous)
	const after = groupByOrigin(next)
	return [...new Set([...before.keys(), ...after.keys()])].filter((origin) => {
		const oldEntries = before.get(origin) ?? []
		const newEntries = after.get(origin) ?? []
		return oldEntries.length !== newEntries.length || oldEntries.some((entry, index) => newEntries[index] === undefined || !hasSameWebsiteApproval(entry, newEntries[index]))
	})
}

export const hasSameWebsiteAccess = (first: WebsiteAccess, second: WebsiteAccess) => hasSameFields(websiteAccessRules, first, second)

export const rollbackWebsiteAccessFields = (previous: WebsiteAccess | undefined, updated: WebsiteAccess, current: WebsiteAccess) => rollbackFields(websiteAccessRules, previous, updated, current)

export type CommittedWebsiteAccessChange = { readonly previousWebsiteAccess: WebsiteAccessArray, readonly updatedWebsiteAccess: WebsiteAccessArray }

// A committed write that can change website approvals, address consent, interceptor-disabled state or request blocking. Its kind, not the call site, decides which websites' runtime approvals fail closed when settings are unreadable (see getAffectedWebsites).
export type CommittedAccessChange =
	// The complete committed or rolled-back snapshots; missing metadata conservatively affects every website.
	| { readonly kind: 'website-access', readonly committedChange?: CommittedWebsiteAccessChange }
	// Address-book entries, which can alter any website's effective address policy.
	| { readonly kind: 'address-book' }

export type AffectedWebsites =
	| { readonly kind: 'every' }
	| { readonly kind: 'none' }
	| { readonly kind: 'websites', readonly websiteOrigins: readonly string[] }

export function getAffectedWebsites(change: CommittedAccessChange): AffectedWebsites {
	switch (change.kind) {
		case 'website-access': {
			if (change.committedChange === undefined) return { kind: 'every' }
			const origins = getWebsiteApprovalChangedOrigins(change.committedChange.previousWebsiteAccess, change.committedChange.updatedWebsiteAccess)
			return origins.length === 0 ? { kind: 'none' } : { kind: 'websites', websiteOrigins: origins }
		}
		case 'address-book': return { kind: 'every' }
		default: return assertNever(change)
	}
}

export const isAffectedWebsite = (affectedWebsites: AffectedWebsites, websiteOrigin: string) => {
	switch (affectedWebsites.kind) {
		case 'every': return true
		case 'none': return false
		case 'websites': return affectedWebsites.websiteOrigins.includes(websiteOrigin)
		default: return assertNever(affectedWebsites)
	}
}

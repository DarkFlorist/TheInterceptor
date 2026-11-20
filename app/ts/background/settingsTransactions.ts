import type { StorageTransactionOutcome } from './storageTransactionOutcome.js'
import type { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { updateWebsiteAccess, updateWebsiteAccessWithSnapshots } from './settings.js'

// Equality, and for transaction-rolled-back types also rollback, for every field of a stored type; the mapped types make a field added to that type without a rule here a compile error.
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

const hasSameWebsiteAccess = (first: WebsiteAccess, second: WebsiteAccess) => hasSameFields(websiteAccessRules, first, second)

async function restoreWebsiteAccessUpdate(previousWebsiteAccess: WebsiteAccessArray, updatedWebsiteAccess: WebsiteAccessArray) {
	return await updateWebsiteAccess((currentWebsiteAccess) => {
		const previousByOrigin = new Map(previousWebsiteAccess.map((entry) => [entry.website.websiteOrigin, entry]))
		const updatedByOrigin = new Map(updatedWebsiteAccess.map((entry) => [entry.website.websiteOrigin, entry]))
		const changedOrigins = new Set([...previousByOrigin.keys(), ...updatedByOrigin.keys()].filter((origin) => {
			const previous = previousByOrigin.get(origin)
			const updated = updatedByOrigin.get(origin)
			if (previous === undefined || updated === undefined) return previous !== updated
			return !hasSameWebsiteAccess(previous, updated)
		}))
		const restoredWebsiteAccess: WebsiteAccess[] = []
		const currentOrigins = new Set<string>()
		for (const current of currentWebsiteAccess) {
			const origin = current.website.websiteOrigin
			currentOrigins.add(origin)
			if (!changedOrigins.has(origin)) {
				restoredWebsiteAccess.push(current)
				continue
			}
			const previous = previousByOrigin.get(origin)
			const updated = updatedByOrigin.get(origin)
			if (updated === undefined) {
				// A concurrent writer recreated an entry removed by this transaction; keep it intact.
				restoredWebsiteAccess.push(current)
				continue
			}
			if (previous === undefined && hasSameWebsiteAccess(current, updated)) continue
			restoredWebsiteAccess.push(rollbackFields(websiteAccessRules, previous, updated, current))
		}
		for (const origin of changedOrigins) {
			if (currentOrigins.has(origin) || updatedByOrigin.has(origin)) continue
			const previous = previousByOrigin.get(origin)
			if (previous !== undefined) restoredWebsiteAccess.push(previous)
		}
		return restoredWebsiteAccess
	})
}

type CommittedWebsiteAccessChange = { readonly previousWebsiteAccess: WebsiteAccessArray, readonly updatedWebsiteAccess: WebsiteAccessArray }
export type WebsiteAccessTransactionOutcome =
	| (Extract<StorageTransactionOutcome, { readonly status: 'completed' }> & { readonly websiteAccess: WebsiteAccessArray, readonly committedChange: CommittedWebsiteAccessChange })
	| (Extract<StorageTransactionOutcome, { readonly status: 'failed' }> & { readonly committedChange?: CommittedWebsiteAccessChange })

// The transaction itself owns the commit/rollback phase, including failures; callers never infer it from a callback being invoked.
export async function tryWebsiteAccessRollback(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>): Promise<WebsiteAccessTransactionOutcome> {
	let snapshots: Awaited<ReturnType<typeof updateWebsiteAccessWithSnapshots>> | undefined
	try {
		snapshots = await updateWebsiteAccessWithSnapshots(update)
		await afterUpdate(snapshots.updatedWebsiteAccess)
		return { status: 'completed', storage: 'written', websiteAccess: snapshots.updatedWebsiteAccess, committedChange: snapshots }
	} catch (error: unknown) {
		if (snapshots === undefined) return { status: 'failed', storage: 'not-written', error }
		try {
			const restoredWebsiteAccess = await restoreWebsiteAccessUpdate(snapshots.previousWebsiteAccess, snapshots.updatedWebsiteAccess)
			return { status: 'failed', storage: 'rolled-back', error, committedChange: { previousWebsiteAccess: snapshots.previousWebsiteAccess, updatedWebsiteAccess: restoredWebsiteAccess } }
		} catch (rollbackError: unknown) {
			let failure: unknown = error
			try {
				await reportUnexpectedError(rollbackError, { code: 'website_access_update_rollback_failed' })
			} catch (reportingError: unknown) {
				failure = new AggregateError([error, rollbackError, reportingError], 'Website access update, rollback and error reporting failed')
			}
			return { status: 'failed', storage: 'rollback-failed', error: failure }
		}
	}
}

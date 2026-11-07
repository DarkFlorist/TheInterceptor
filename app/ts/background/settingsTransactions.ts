import type { Website, WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { snapshotSettingsImportStorage, updateWebsiteAccess, updateWebsiteAccessWithSnapshots } from './settings.js'

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

const websiteAccessRules = {
	website: {
		isSame: (first, second) => hasSameFields(websiteRules, first, second),
		rollback: (previous, updated, current) => rollbackFields(websiteRules, previous, updated, current),
	},
	addressAccess: revertUnlessOverwritten(hasSameAddressAccess),
	access: revertUnlessOverwritten<boolean>(Object.is),
	interceptorDisabled: revertUnlessOverwritten<boolean>(Object.is),
	declarativeNetRequestBlockMode: revertUnlessOverwritten<WebsiteAccess['declarativeNetRequestBlockMode']>(Object.is),
} satisfies FieldRules<WebsiteAccess>

const hasSameWebsiteAccess = (first: WebsiteAccess, second: WebsiteAccess) => hasSameFields(websiteAccessRules, first, second)

async function restoreWebsiteAccessUpdate(previousWebsiteAccess: WebsiteAccessArray, updatedWebsiteAccess: WebsiteAccessArray) {
	await updateWebsiteAccess((currentWebsiteAccess) => {
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

// Merge-and-restore: if afterUpdate fails, reverts only the fields this update changed that no concurrent writer has overwritten since.
export async function withWebsiteAccessRollback(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray, afterUpdate: (websiteAccess: WebsiteAccessArray) => Promise<void>) {
	let snapshots: Awaited<ReturnType<typeof updateWebsiteAccessWithSnapshots>> | undefined
	try {
		snapshots = await updateWebsiteAccessWithSnapshots(update)
		await afterUpdate(snapshots.updatedWebsiteAccess)
		return snapshots.updatedWebsiteAccess
	} catch (error: unknown) {
		if (snapshots !== undefined) {
			try {
				await restoreWebsiteAccessUpdate(snapshots.previousWebsiteAccess, snapshots.updatedWebsiteAccess)
			} catch (rollbackError: unknown) {
				await reportUnexpectedError(rollbackError, { code: 'website_access_update_rollback_failed' })
			}
		}
		throw error
	}
}

const settingsImportSemaphore = new Semaphore(1)

// Restores the raw pre-import values of every storage key the import writes when the import fails.
export async function withSettingsImportRollback<T>(importSettings: () => Promise<T>) {
	return await settingsImportSemaphore.execute(async () => {
		const restorePreImportStorage = await snapshotSettingsImportStorage()
		try {
			return await importSettings()
		} catch (error: unknown) {
			try {
				await restorePreImportStorage()
			} catch (rollbackError: unknown) {
				await reportUnexpectedError(rollbackError, { code: 'settings_import_rollback_failed' })
			}
			throw error
		}
	})
}

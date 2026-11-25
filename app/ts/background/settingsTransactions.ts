import { hasSameWebsiteAccess, rollbackWebsiteAccessFields, type CommittedWebsiteAccessChange } from './websiteAccessState.js'
import type { StorageTransactionOutcome } from './storageTransactionOutcome.js'
import type { WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { updateWebsiteAccess, updateWebsiteAccessWithSnapshots } from './settings.js'

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
			restoredWebsiteAccess.push(rollbackWebsiteAccessFields(previous, updated, current))
		}
		for (const origin of changedOrigins) {
			if (currentOrigins.has(origin) || updatedByOrigin.has(origin)) continue
			const previous = previousByOrigin.get(origin)
			if (previous !== undefined) restoredWebsiteAccess.push(previous)
		}
		return restoredWebsiteAccess
	})
}

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

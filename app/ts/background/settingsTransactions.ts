import type { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSet } from '../utils/storageUtils.js'
import { hasOwnKey } from '../utils/typescript.js'
import { exportSettingsAndAddressBook, importSettingsAndAddressBook, updateWebsiteAccess, updateWebsiteAccessWithSnapshots } from './settings.js'

function hasSameAddressAccess(first: readonly WebsiteAddressAccess[] | undefined, second: readonly WebsiteAddressAccess[] | undefined) {
	if (first === undefined || second === undefined) return first === second
	return first.length === second.length && first.every((entry, index) => entry.address === second[index]?.address && entry.access === second[index]?.access)
}

function hasSameWebsiteAccess(first: WebsiteAccess, second: WebsiteAccess) {
	return first.website.websiteOrigin === second.website.websiteOrigin
		&& first.website.title === second.website.title
		&& first.website.icon === second.website.icon
		&& first.access === second.access
		&& first.interceptorDisabled === second.interceptorDisabled
		&& first.declarativeNetRequestBlockMode === second.declarativeNetRequestBlockMode
		&& hasSameAddressAccess(first.addressAccess, second.addressAccess)
}

function rollbackValue<Value>(previous: Value, updated: Value, current: Value, hasSameValue: (first: Value, second: Value) => boolean = Object.is) {
	return !hasSameValue(previous, updated) && hasSameValue(current, updated) ? previous : current
}

function rollbackWebsiteAccessEntry(previous: WebsiteAccess | undefined, updated: WebsiteAccess, current: WebsiteAccess): WebsiteAccess {
	const access = rollbackValue(previous?.access, updated.access, current.access)
	const interceptorDisabled = rollbackValue(previous?.interceptorDisabled, updated.interceptorDisabled, current.interceptorDisabled)
	const declarativeNetRequestBlockMode = rollbackValue(previous?.declarativeNetRequestBlockMode, updated.declarativeNetRequestBlockMode, current.declarativeNetRequestBlockMode)
	return {
		website: {
			websiteOrigin: current.website.websiteOrigin,
			title: rollbackValue(previous?.website.title, updated.website.title, current.website.title),
			icon: rollbackValue(previous?.website.icon, updated.website.icon, current.website.icon),
		},
		addressAccess: rollbackValue(previous?.addressAccess, updated.addressAccess, current.addressAccess, hasSameAddressAccess),
		...(access === undefined ? {} : { access }),
		...(interceptorDisabled === undefined ? {} : { interceptorDisabled }),
		...(declarativeNetRequestBlockMode === undefined ? {} : { declarativeNetRequestBlockMode }),
	}
}

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
			restoredWebsiteAccess.push(rollbackWebsiteAccessEntry(previous, updated, current))
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

// Restores the pre-import settings, address book and active signing address when the import fails.
export async function withSettingsImportRollback<T>(importSettings: () => Promise<T>) {
	return await settingsImportSemaphore.execute(async () => {
		const [exportedSettingsBeforeImport, activeSigningAddressStorage] = await Promise.all([
			exportSettingsAndAddressBook(),
			browserStorageLocalGet('activeSigningAddress'),
		])
		const activeSigningAddressWasPresent = hasOwnKey(activeSigningAddressStorage, 'activeSigningAddress')
		const { activeSigningAddress } = activeSigningAddressStorage
		try {
			return await importSettings()
		} catch (error: unknown) {
			try {
				await importSettingsAndAddressBook(exportedSettingsBeforeImport)
				if (activeSigningAddressWasPresent) await browserStorageLocalSet({ activeSigningAddress })
				else await browserStorageLocalRemove('activeSigningAddress')
			} catch (rollbackError: unknown) {
				await reportUnexpectedError(rollbackError, { code: 'settings_import_rollback_failed' })
			}
			throw error
		}
	})
}

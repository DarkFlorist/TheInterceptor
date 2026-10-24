import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { getConnectionAccess, reconcileWebsiteApprovalAccesses, refreshIconsAfterWebsiteAccessUpdate, setAccess, type WebsiteAccessUpdate } from './accessManagement.js'
import { getWebsiteSocketConnection, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { retrieveWebsiteDetails } from './iconHandler.js'
import { getSettings } from './settings.js'
import { withSettingsTransitionLock } from './settingsTransitionLock.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'

// Website approval updates in three steps: reconcile port approvals with the stored settings under the settings transition lock, then (after releasing it) prompt connections that want access, then refresh toolbar icons.

type WebsiteApprovalSyncOptions = {
	readonly promptForAccessesIfNeeded: boolean
	readonly throwOnError?: boolean
}

async function promptForWebsiteAccesses(websiteTabConnections: WebsiteTabConnections, throwOnError: boolean) {
	for (const tabConnection of websiteTabConnections.values()) {
		for (const connection of Object.values(tabConnection.connections)) {
			if (!connection.wantsToConnect) continue
			try {
				// Reconciliation uses the committed snapshot; deferred prompts must recheck the latest settings.
				const settings = await getSettings()
				const { activeAddress, access } = await getConnectionAccess(websiteTabConnections, connection, settings)
				if (access !== 'askAccess') continue
				if (getWebsiteSocketConnection(websiteTabConnections, connection.socket) === undefined) continue
				const website = { websiteOrigin: connection.websiteOrigin, ...await retrieveWebsiteDetails(connection.socket.tabId, connection.websiteOrigin) }
				await requestAccessFromUser(websiteTabConnections, connection.socket, website, undefined, activeAddress, settings, activeAddress, undefined)
			} catch (error) {
				if (throwOnError) throw error
				await reportUnexpectedError(error)
			}
		}
	}
}

// Call after releasing the settings transition lock: access dialogs can activate another address.
export async function finishWebsiteAccessUpdate(
	websiteTabConnections: WebsiteTabConnections,
	update: WebsiteAccessUpdate,
	{ promptForAccessesIfNeeded, throwOnError = false }: WebsiteApprovalSyncOptions,
) {
	if (promptForAccessesIfNeeded) await promptForWebsiteAccesses(websiteTabConnections, throwOnError)
	await refreshIconsAfterWebsiteAccessUpdate(websiteTabConnections, update, throwOnError)
}

export async function syncWebsiteApprovalsWithSettings(websiteTabConnections: WebsiteTabConnections, options: WebsiteApprovalSyncOptions): Promise<WebsiteAccessUpdate> {
	const update = await withSettingsTransitionLock(async (lock) => await reconcileWebsiteApprovalAccesses(websiteTabConnections, await lock.readSettings(), options.throwOnError))
	await finishWebsiteAccessUpdate(websiteTabConnections, update, options)
	return update
}

export async function finalizeWebsiteAccessChange(websiteTabConnections: WebsiteTabConnections, promptForAccessesIfNeeded: boolean) {
	await syncWebsiteApprovalsWithSettings(websiteTabConnections, { promptForAccessesIfNeeded })
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function persistWebsiteAccessChange(
	websiteTabConnections: WebsiteTabConnections,
	website: Website,
	access: boolean,
	address: bigint | undefined,
	promptForAccessesIfNeeded: boolean,
) {
	await setAccess(website, access, address)
	await finalizeWebsiteAccessChange(websiteTabConnections, promptForAccessesIfNeeded)
}

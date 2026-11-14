import { modifyObject } from '../utils/typescript.js'
import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import { getHostWithPort, getTabIfExists, silenceChromeUnCaughtPromise, type WebsiteSocket } from '../utils/requests.js'
import type { TabConnection, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { updateDeclarativeNetRequestBlocksForRegisteredConnection } from './accessManagement.js'
import { isTopFramePort } from './backgroundUtils.js'
import { throwAfterFollowUp } from './committedWriteReconciliation.js'
import { updateExtensionIcon } from './iconHandler.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { registerWebsiteConnectionAndProvisionallyClaimSignerState } from './signerStateOwnership.js'
import { updateTabState } from './storageVariables.js'

export type WebsiteConnectionRegistration = {
	readonly provisionallyClaimedSignerState: boolean
}

type RegisteredConnectionIconRefresh = {
	readonly websiteTabConnections: WebsiteTabConnections
	readonly socket: WebsiteSocket
	readonly websiteOrigin: string
	readonly isTopFrame: boolean
	readonly createdTabConnection: boolean
	readonly requestBlocksReconciliation: Promise<boolean>
}

// Child frames publish their own website into tab state, so the tab's top-level website is its top-frame connection's when exactly one top-level website is connected. When none is, or a navigation left the previous page's port registered beside the new one, the tab's URL decides instead of connection order; undefined when neither is known.
async function getTopLevelWebsiteOrigin(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	const connections = Object.values(websiteTabConnections.get(tabId)?.connections ?? {})
	const topFrameOrigins = new Set(connections.filter((connection) => isTopFramePort(connection.port)).map((connection) => connection.websiteOrigin))
	const [onlyTopFrameOrigin] = topFrameOrigins
	if (topFrameOrigins.size === 1 && onlyTopFrameOrigin !== undefined) return onlyTopFrameOrigin
	const tabUrl = (await getTabIfExists(tabId))?.url
	return tabUrl === undefined ? undefined : getHostWithPort(tabUrl)
}

// The icon reports applied request blocking, so it is refreshed once the registration's reconciliation settles, whether or not that succeeds (a failure can follow a partial rule update). A new tab always gets its first icon; an existing tab is refreshed whenever the reconciliation ran, because a consented child frame can make the whole tab blocked. A child frame's icon is resolved for the tab's top-level website, not the frame's.
async function refreshIconAfterRequestBlocks({ websiteTabConnections, socket, websiteOrigin, isTopFrame, createdTabConnection, requestBlocksReconciliation }: RegisteredConnectionIconRefresh) {
	const refreshIcon = async (reconciled: boolean) => {
		if (!createdTabConnection && !reconciled) return
		const iconWebsiteOrigin = createdTabConnection || isTopFrame ? websiteOrigin : await getTopLevelWebsiteOrigin(websiteTabConnections, socket.tabId)
		// Without a known top-level website the icon is left to the tab's navigation-complete refresh.
		if (iconWebsiteOrigin !== undefined) await updateExtensionIcon(socket.tabId, iconWebsiteOrigin, bumpPopupRefreshGeneration())
	}
	let reconciled: boolean
	try {
		reconciled = await requestBlocksReconciliation
	} catch (reconciliationFailure: unknown) {
		// A rejected reconciliation ran, so its tab blocking may have changed: the icon is still refreshed, and a refresh failure is reported after the reconciliation failure instead of replacing it.
		return await throwAfterFollowUp(reconciliationFailure, async () => await refreshIcon(true))
	}
	await refreshIcon(reconciled)
}

// Registers a content script connection and everything that has to follow it, in order. Every registered connection, including a child frame in an existing tab, can make its tab eligible for request blocking (persisted consent while the RPC configuration is not ready), so blocking is reconciled for each one. That reconciliation is not awaited, so connection setup latency is unchanged: the icon refresh that observes it goes to `observeRequestBlocks`, the caller's error boundary. It is handed over after the new tab's first state write, so the icon follows that state, and even when the write fails, so the reconciliation is always observed while the write failure still propagates; the refresh only reads state and writes the icon, so it is harmless after a failed write.
export async function registerWebsiteConnection(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	connection: TabConnection['connections'][string],
	isTopFrame: boolean,
	observeRequestBlocks: (refreshIcon: () => Promise<void>) => void,
): Promise<WebsiteConnectionRegistration> {
	const { websiteOrigin } = connection
	const { createdTabConnection, provisionallyClaimedSignerState } = await registerWebsiteConnectionAndProvisionallyClaimSignerState(websiteTabConnections, socket, connection, isTopFrame)
	// Guarded so a failure before the error boundary attaches its handler is not reported as an unhandled rejection; the boundary still observes it.
	const requestBlocksReconciliation = silenceChromeUnCaughtPromise(updateDeclarativeNetRequestBlocksForRegisteredConnection(websiteTabConnections))
	try {
		if (createdTabConnection) {
			await updateTabState(socket.tabId, (previousState: TabState) => modifyObject(previousState, {
				website: { websiteOrigin, icon: undefined, title: undefined },
				tabIconDetails: { icon: ICON_NOT_ACTIVE, iconReason: 'No active address selected.' },
			}))
		}
	} finally {
		observeRequestBlocks(async () => await refreshIconAfterRequestBlocks({ websiteTabConnections, socket, websiteOrigin, isTopFrame, createdTabConnection, requestBlocksReconciliation }))
	}
	return { provisionallyClaimedSignerState }
}

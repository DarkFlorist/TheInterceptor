import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getActiveAddress } from './backgroundUtils.js'
import { getActiveAddressForCurrentSignerState } from './signerStateOwnership.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

// The account that a website request from this tab acts for: the account getActiveAddress resolves, as long as the signer state it was resolved from is still current.
export async function getActiveAddressForRequest(settings: Settings, websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, tabId, async () => await getActiveAddress(settings, tabId))
}

export async function getWebsiteActiveAddress(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddressForRequest(settings, websiteTabConnections, socket.tabId)
	if (activeAddress === undefined) return undefined
	return hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress) === 'hasAccess' ? activeAddress : undefined
}

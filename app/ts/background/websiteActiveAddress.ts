import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getActiveAddress } from './backgroundUtils.js'
import { getActiveAddressForCurrentSignerState } from './signerStateOwnership.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'

export async function getWebsiteActiveAddress(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, socket.tabId, async () => await getActiveAddress(settings, socket.tabId))
	if (activeAddress === undefined) return undefined
	return hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress) === 'hasAccess' ? activeAddress : undefined
}

import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import type { RequestAccessContext } from './requestAccessContext.js'
import { getWebsiteSocketConnection, isTopFramePort } from './backgroundUtils.js'
import { getNativeHostedSiteContext } from './nativeHostedSiteContext.js'

// Only native-hosted read admission borrows a verified host's address. A failed native context is handled with an absent address rather than falling back to the child's ordinary account or cached connection approval.
export async function getSiteReadRequestAccessContext(connections: WebsiteTabConnections, request: InterceptedRequest, settings: Settings): Promise<RequestAccessContext | undefined> {
	if (request.method !== 'site_rpc_request') return undefined
	const socket = request.uniqueRequestIdentifier.requestSocket
	const connection = getWebsiteSocketConnection(connections, socket)
	if (connection === undefined || isTopFramePort(connection.port)) return undefined
	const context = await getNativeHostedSiteContext(connections, socket, settings)
	const host = context === undefined ? undefined : getWebsiteSocketConnection(connections, context.hostSocket)
	return { activeAddress: host === undefined ? undefined : context?.activeAddress, accessSocket: context?.hostSocket ?? socket, accessOrigin: host?.websiteOrigin ?? connection.websiteOrigin, requireAddressAccess: true, isCurrent: context?.isCurrent ?? (async () => false) }
}

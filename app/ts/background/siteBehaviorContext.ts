import { resolveSiteBehavior } from '../utils/siteBehaviors.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getWebsiteSocketConnection, getWebsiteSocketRequestOrigin } from './backgroundUtils.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'

// Reuse the original browser-derived full frame origin recorded at connection registration, just like signing-origin checks. Never reparse a later port URL or accept an origin selected by the page.
export function getConnectionOrigin(connections: WebsiteTabConnections, socket: WebsiteSocket) {
	const connection = getWebsiteSocketConnection(connections, socket)
	return connection === undefined ? undefined : getWebsiteSocketRequestOrigin(connections, socket, connection.websiteOrigin)
}

export function publishSiteBehaviors(connections: WebsiteTabConnections, socket: WebsiteSocket, simulationChainId?: bigint, simulationAddress?: bigint) {
	const origin = getConnectionOrigin(connections, socket)
	const behavior = origin === undefined ? undefined : resolveSiteBehavior(origin)
	if (behavior === undefined) return false
	const rpcInterception = simulationChainId === undefined ? undefined : { origin: behavior.origin, chainId: simulationChainId, ...behavior.rpcReads, ...(simulationAddress === undefined ? {} : { address: simulationAddress }) }
	return sendSubscriptionReplyOrCallBack(connections, socket, { type: 'result', method: 'site_behavior', result: rpcInterception === undefined ? {} : { rpcInterception } })
}

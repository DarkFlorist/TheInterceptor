import { resolveSiteBehavior } from '../utils/siteBehaviors.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getConnectionOrigin } from './backgroundUtils.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'

export function publishSiteBehaviors(connections: WebsiteTabConnections, socket: WebsiteSocket, simulationChainId?: bigint, simulationAddress?: bigint) {
	const origin = getConnectionOrigin(connections, socket)
	const behavior = origin === undefined ? undefined : resolveSiteBehavior(origin)
	if (behavior === undefined) return false
	const rpcInterception = simulationChainId === undefined ? undefined : { origin: behavior.origin, chainId: simulationChainId, ...behavior.rpcReads, ...(simulationAddress === undefined ? {} : { address: simulationAddress }) }
	return sendSubscriptionReplyOrCallBack(connections, socket, { type: 'result', method: 'site_behavior', result: rpcInterception === undefined ? {} : { rpcInterception } })
}

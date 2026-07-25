import type { RPCReply } from '../types/interceptor-messages.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { invalidWatchAssetRequest } from './windows/watchAsset.js'

export function getMethodSpecificRpcParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	switch (request.method) {
		case 'wallet_watchAsset': return invalidWatchAssetRequest('Invalid wallet_watchAsset parameters.')
		default: return undefined
	}
}

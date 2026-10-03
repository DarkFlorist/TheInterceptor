import type { RPCReply } from '../types/interceptor-messages.js'
import type { InterceptedRequest } from '../utils/requests.js'

export const watchAssetRequestError = (message: string, code = -32602) => ({
	type: 'result' as const,
	method: 'wallet_watchAsset' as const,
	error: { code, message },
})

export const invalidWatchAssetRequest = (message: string) => watchAssetRequestError(message)

export function getWatchAssetRpcParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	if (request.method !== 'wallet_watchAsset') return undefined
	return invalidWatchAssetRequest('Invalid wallet_watchAsset parameters.')
}

import { EthereumJsonRpcRequest, type EthereumJsonRpcRequest as EthereumJsonRpcRequestType } from '../types/JsonRpc-types.js'
import type { InterceptedRequest } from '../utils/requests.js'

export const invalidWatchAssetRequest = (message: string) => ({
	type: 'result' as const,
	method: 'wallet_watchAsset' as const,
	error: { code: -32602, message },
})

type BackgroundRpcParseResult =
	| { success: true, value: EthereumJsonRpcRequestType }
	| { success: false, fullError: unknown, invalidRequestReply: ReturnType<typeof invalidWatchAssetRequest> | undefined }

export function parseEthereumJsonRpcRequestForBackground(request: InterceptedRequest): BackgroundRpcParseResult {
	const parsed = EthereumJsonRpcRequest.safeParse(request)
	if (parsed.success) return parsed
	return {
		success: false,
		fullError: parsed.fullError,
		invalidRequestReply: request.method === 'wallet_watchAsset' ? invalidWatchAssetRequest('Invalid wallet_watchAsset parameters.') : undefined,
	}
}

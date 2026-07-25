import { EthereumJsonRpcRequest, type EthereumJsonRpcRequest as EthereumJsonRpcRequestType } from '../types/JsonRpc-types.js'
import type { InterceptedRequest } from '../utils/requests.js'

type BackgroundRpcParseResult =
	| { success: true, value: EthereumJsonRpcRequestType }
	| { success: false, fullError: unknown }

export function parseEthereumJsonRpcRequestForBackground(request: InterceptedRequest): BackgroundRpcParseResult {
	const parsed = EthereumJsonRpcRequest.safeParse(request)
	if (parsed.success) return parsed
	return {
		success: false,
		fullError: parsed.fullError,
	}
}

import type { RPCReply } from '../types/interceptor-messages.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'

export function getWalletGetCapabilitiesParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	if (request.method !== 'wallet_getCapabilities') return undefined
	return {
		type: 'result',
		method: request.method,
		error: {
			code: JSON_RPC_ERROR_CODE_INVALID_PARAMS,
			message: 'Invalid wallet_getCapabilities parameters.',
		},
	}
}

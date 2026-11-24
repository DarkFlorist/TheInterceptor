import type { RPCReply } from '../types/interceptor-messages.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'

// Keep public wording independent of validator diagnostics and schema details.
export function getInvalidRpcParamsReply(request: InterceptedRequest): RPCReply {
	return {
		type: 'result',
		method: request.method,
		error: {
			code: JSON_RPC_ERROR_CODE_INVALID_PARAMS,
			message: `Invalid ${ request.method } parameters.`,
		},
	}
}

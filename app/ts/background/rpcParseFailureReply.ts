import type { Failure } from 'funtypes'
import type { RPCReply } from '../types/interceptor-messages.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS } from '../utils/constants.js'
import { getWatchAssetRpcParseFailureReply } from './watchAssetRpc.js'
import { getWalletGetCapabilitiesParseFailureReply } from './walletGetCapabilitiesRpc.js'

// Method-specific parse failure replies take precedence over the generic invalid-params message.
const METHOD_SPECIFIC_PARSE_FAILURE_REPLIES = [getWatchAssetRpcParseFailureReply, getWalletGetCapabilitiesParseFailureReply]

export function getMethodSpecificParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	for (const getMethodSpecificReply of METHOD_SPECIFIC_PARSE_FAILURE_REPLIES) {
		const methodSpecificReply = getMethodSpecificReply(request)
		if (methodSpecificReply !== undefined) return methodSpecificReply
	}
	return undefined
}

// Use the existing method failure without reparsing values or interpreting funtypes' failure path grammar.
const MAX_REASON_LENGTH = 200

export function getInvalidRpcParamsReply(request: InterceptedRequest, failure: Failure): RPCReply {
	const reason = failure.message.trim().replace(/\.$/, '')
	const boundedReason = reason.length <= MAX_REASON_LENGTH ? `${ reason }.` : `${ reason.slice(0, MAX_REASON_LENGTH) }...`
	return {
		type: 'result',
		method: request.method,
		error: {
			code: JSON_RPC_ERROR_CODE_INVALID_PARAMS,
			message: `Invalid ${ request.method } parameters: ${ boundedReason }`,
		},
	}
}

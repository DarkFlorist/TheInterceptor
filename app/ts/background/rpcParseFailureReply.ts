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

// Public guidance is owned here; validator diagnostics belong only in background logs. Unlisted methods retain the stable generic message used by the wallet handlers.
const PARAMETER_GUIDANCE = new Map<string, string>([
	['eth_getBalance', 'Expected [address, block tag].'],
	['eth_sendTransaction', 'Expected [transaction] with valid transaction fields and addresses.'],
	['eth_getBlockByNumber', 'Expected [block tag, include transactions boolean].'],
	['eth_subscribe', 'Expected one subscription type: newHeads, logs, newPendingTransactions, or syncing.'],
	['eth_signTypedData_v4', 'Expected [address, EIP-712 typed data] within the supported nesting depth.'],
	['eth_call', 'Expected [transaction] or [transaction, block tag].'],
	['wallet_revokePermissions', 'Expected [{ eth_accounts: {} }] with no additional permissions or fields.'],
])

export function getInvalidRpcParamsReply(request: InterceptedRequest): RPCReply {
	const guidance = PARAMETER_GUIDANCE.get(request.method)
	return {
		type: 'result',
		method: request.method,
		error: {
			code: JSON_RPC_ERROR_CODE_INVALID_PARAMS,
			message: `Invalid ${ request.method } parameters${ guidance === undefined ? '.' : `: ${ guidance }` }`,
		},
	}
}

import type { RPCReply } from '../types/interceptor-messages.js'
import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { SafeTx } from '../types/personal-message-definitions.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { assertInterceptorSafeTransactionPolicy } from './safeCore.js'

const SAFE_MESSAGE_SIGNING_METHODS = new Set([
	'personal_sign',
	'eth_sign',
	'eth_signTypedData',
	'eth_signTypedData_v1',
	'eth_signTypedData_v2',
	'eth_signTypedData_v3',
	'eth_signTypedData_v4',
])

function safeModeUnsupportedMethod(method: string, message: string): RPCReply {
	return {
		type: 'result',
		method,
		error: {
			code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
			message,
		},
	}
}

export function getSafeModeRpcPolicyReply(options: {
	readonly rawRequest: InterceptedRequest
	readonly parsedRequest: EthereumJsonRpcRequest | undefined
	readonly safeSigningMode: boolean
	readonly forwardToSigner: boolean
	readonly activeAddress: bigint | undefined
	readonly chainId: bigint
	readonly hasRpcConnection: boolean
}): RPCReply | undefined {
	if (!options.safeSigningMode) return undefined
	if (options.parsedRequest === undefined) {
		return options.forwardToSigner
			? safeModeUnsupportedMethod(
				options.rawRequest.method,
				'This RPC method is not supported while a Gnosis Safe is the active signing account.',
			)
			: undefined
	}
	if (
		SAFE_MESSAGE_SIGNING_METHODS.has(options.parsedRequest.method)
		&& !isSafeTransactionCoSignRequest(options.parsedRequest, options.activeAddress, options.chainId)
	) {
		return safeModeUnsupportedMethod(
			options.parsedRequest.method,
			'Gnosis Safe message signing is not supported. Only Gnosis Safe transaction proposals for the active Gnosis Safe can be co-signed.',
		)
	}
	if (
		!options.hasRpcConnection
		&& (options.parsedRequest.method === 'eth_sendTransaction' || options.parsedRequest.method === 'eth_sendRawTransaction')
	) {
		return safeModeUnsupportedMethod(
			options.parsedRequest.method,
			'Gnosis Safe transaction proposals require an Interceptor RPC connection for live Gnosis Safe validation.',
		)
	}
	return undefined
}

export function isSafeTransactionCoSignRequest(
	request: EthereumJsonRpcRequest,
	activeAddress: bigint | undefined,
	chainId: bigint,
) {
	if (request.method !== 'eth_signTypedData_v4' || activeAddress === undefined) return false
	const [requestedAccount, typedData] = request.params
	const parsedSafeTx = SafeTx.safeParse(typedData)
	if (
		requestedAccount !== activeAddress
		|| !parsedSafeTx.success
		|| parsedSafeTx.value.domain.chainId !== chainId
		|| parsedSafeTx.value.domain.verifyingContract !== activeAddress
	) return false
	try {
		assertInterceptorSafeTransactionPolicy(parsedSafeTx.value)
		return true
	} catch {
		return false
	}
}

import type { GnosisSafeMessageReview } from '../types/gnosisSafeReview.js'
import type { ConfirmationRequest } from '../types/confirmationRequest.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import type { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { isValidMessage } from '../utils/eip712.js'
import { GnosisSafeMessage } from './gnosisSafeMessage.js'
import { GnosisSafeTx } from '../types/personal-message-definitions.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import { assertInterceptorGnosisSafeTransactionPolicy } from './gnosisSafeCore.js'

const GNOSIS_SAFE_MESSAGE_SIGNING_METHODS = new Set([
	'personal_sign',
	'eth_sign',
	'eth_signTypedData',
	'eth_signTypedData_v1',
	'eth_signTypedData_v2',
	'eth_signTypedData_v3',
	'eth_signTypedData_v4',
])

function gnosisSafeModeUnsupportedMethod(method: string, message: string): RPCReply {
	return {
		type: 'result',
		method,
		error: {
			code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
			message,
		},
	}
}

export function getGnosisSafeModeRpcPolicyReply(options: {
	readonly rawRequest: InterceptedRequest
	readonly confirmation?: ConfirmationRequest
	readonly parsedRequest: EthereumJsonRpcRequest | undefined
	readonly safeSigningMode: boolean
	readonly simulationMode?: boolean
	readonly forwardToSigner: boolean
	readonly activeAddress: bigint | undefined
	readonly chainId: bigint
	readonly hasRpcConnection: boolean
}): RPCReply | undefined {
	if (!options.safeSigningMode) {
		if (!options.simulationMode && (options.confirmation?.kind === 'transaction' ? options.confirmation.safeTransaction !== undefined : options.confirmation?.review !== undefined)) return gnosisSafeModeUnsupportedMethod(options.rawRequest.method, 'Gnosis Safe operations require an active Gnosis Safe signing account.')
		return undefined
	}
	if (options.parsedRequest === undefined) {
		return options.forwardToSigner
			? gnosisSafeModeUnsupportedMethod(
				options.rawRequest.method,
				'This RPC method is not supported while a Gnosis Safe is the active signing account.',
			)
			: undefined
	}
	if (
		GNOSIS_SAFE_MESSAGE_SIGNING_METHODS.has(options.parsedRequest.method)
		&& !isGnosisSafeTransactionCoSignRequest(options.parsedRequest, options.activeAddress, options.chainId)
		&& !isGnosisSafeMessageCoSignRequest(options.parsedRequest, options.activeAddress, options.chainId, options.confirmation?.kind === 'message' ? options.confirmation.review : undefined)
	) {
		return gnosisSafeModeUnsupportedMethod(
			options.parsedRequest.method,
			'This Gnosis Safe message signing request is not supported. Use a Gnosis Safe Apps message request or a transaction proposal for the active Gnosis Safe.',
		)
	}
	if (
		!options.hasRpcConnection
		&& (options.parsedRequest.method === 'eth_sendTransaction' || options.parsedRequest.method === 'eth_sendRawTransaction')
	) {
		return gnosisSafeModeUnsupportedMethod(
			options.parsedRequest.method,
			'Gnosis Safe transaction proposals require an Interceptor RPC connection for live Gnosis Safe validation.',
		)
	}
	return undefined
}

export function isGnosisSafeTransactionCoSignRequest(
	request: EthereumJsonRpcRequest,
	activeAddress: bigint | undefined,
	chainId: bigint,
) {
	if (request.method !== 'eth_signTypedData_v4' || activeAddress === undefined) return false
	const [requestedAccount, typedData] = request.params
	const parsedSafeTx = GnosisSafeTx.safeParse(typedData)
	if (
		requestedAccount !== activeAddress
		|| !parsedSafeTx.success
		|| parsedSafeTx.value.domain.chainId !== chainId
		|| parsedSafeTx.value.domain.verifyingContract !== activeAddress
	) return false
	try {
		assertInterceptorGnosisSafeTransactionPolicy(parsedSafeTx.value)
		return true
	} catch {
		return false
	}
}

export function isGnosisSafeMessageCoSignRequest(request: EthereumJsonRpcRequest, activeAddress: bigint | undefined, chainId: bigint, review?: GnosisSafeMessageReview) {
	if (request.method !== 'eth_signTypedData_v4' || activeAddress === undefined || request.params[0] !== activeAddress || !isValidMessage(request).valid) return false
	const message = GnosisSafeMessage.safeParse({ typedData: request.params[1], review })
	return message.success && message.value.typedData.domain.chainId === chainId && message.value.typedData.domain.verifyingContract === activeAddress
}

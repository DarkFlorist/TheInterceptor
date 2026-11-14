import * as funtypes from 'funtypes'
import type { RPCReply, Settings } from '../types/interceptor-messages.js'
import { WALLET_SEND_CALLS_VERSION, type WalletSendCalls, type WalletShowCallsStatus } from '../types/JsonRpc-types.js'
import { JSON_RPC_ERROR_CODE_INVALID_PARAMS, METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../utils/constants.js'
import type { InterceptedRequest } from '../utils/requests.js'
import { walletSendCallsUnknownBundleIdError, type WalletSendCallsError } from './walletSendCalls.js'

// When the RPC layer refuses the EIP-5792 methods. Call batches are only supported in simulation mode, where an approved batch becomes separate transactions on the simulation stack, exactly as it was simulated:
// - Signing mode refuses wallet_sendCalls, wallet_getCallsStatus and wallet_showCallsStatus before their parameters are parsed and without forwarding them to the signer (see getSigningModeWalletCallsReply), so websites send each call with eth_sendTransaction, which the Interceptor reviews on its own.
// - In simulation mode, a request whose parameters do not parse gets getWalletSendCallsParseFailureReply, and wallet_sendCalls needs an Interceptor RPC to simulate the calls (see getWalletSendCallsWithoutInterceptorRpcReply). A parsed batch is then canonicalized (canonicalizeWalletSendCalls in walletSendCalls.ts) and admitted by the confirmation window (walletSendCallsConfirmation.ts).
// - wallet_getCallsStatus is answered from the simulation stack (walletSendCallsStatus.ts). wallet_showCallsStatus would open bundle status UI, which the Interceptor does not have.
// - wallet_getCapabilities is answered locally in every mode (see walletCapabilities.ts), so websites are never offered the signer's batch capabilities.

export const getWalletCallsErrorReply = (method: string, error: WalletSendCallsError): RPCReply => ({ type: 'result', method, error })

// The Interceptor simulates each call as a separate transaction, but a wallet may execute an atomicRequired: false batch atomically in one transaction, where state such as transient storage carries over between the calls. Such a preview cannot be bound to what the wallet executes, so signing mode refuses the batch and knows no bundles. Simulation mode is not refused here.
export function getSigningModeWalletCallsReply(request: InterceptedRequest, settings: Pick<Settings, 'simulationMode'>): RPCReply | undefined {
	if (settings.simulationMode) return undefined
	switch (request.method) {
		// viem falls back to eth_sendTransaction when the error message contains MetaMask's "does not exist / is not available" wording for unsupported methods; the 4200 code alone does not trigger its fallback.
		case 'wallet_sendCalls': return getWalletCallsErrorReply(request.method, {
			code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
			message: 'wallet_sendCalls does not exist / is not available in Interceptor signing mode. The Interceptor reviews each call as a separate transaction, but a wallet may execute a batch atomically, where state such as transient storage carries over between the calls. Send each call with eth_sendTransaction instead.',
		})
		case 'wallet_getCallsStatus':
		case 'wallet_showCallsStatus': return getWalletCallsErrorReply(request.method, walletSendCallsUnknownBundleIdError)
		default: return undefined
	}
}

const RequestedWalletSendCallsVersion = funtypes.ReadonlyObject({ params: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ version: funtypes.String })) })

export function getWalletSendCallsParseFailureReply(request: InterceptedRequest): RPCReply | undefined {
	switch (request.method) {
		case 'wallet_sendCalls': {
			const requestedVersion = RequestedWalletSendCallsVersion.safeParse(request)
			const message = requestedVersion.success && requestedVersion.value.params[0].version !== WALLET_SEND_CALLS_VERSION
				? `Unsupported wallet_sendCalls version ${ requestedVersion.value.params[0].version }. The Interceptor supports EIP-5792 version ${ WALLET_SEND_CALLS_VERSION }.`
				: `Invalid wallet_sendCalls version ${ WALLET_SEND_CALLS_VERSION } parameters: chainId and calls are required, atomicRequired must be a boolean when present, calls may only contain to, data, value and capabilities, hex values must be 0x-prefixed, and unknown fields are rejected.`
			return getWalletCallsErrorReply(request.method, { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message })
		}
		case 'wallet_getCallsStatus':
		case 'wallet_showCallsStatus': return getWalletCallsErrorReply(request.method, { code: JSON_RPC_ERROR_CODE_INVALID_PARAMS, message: `Invalid ${ request.method } parameters.` })
		default: return undefined
	}
}

export const getWalletSendCallsWithoutInterceptorRpcReply = (request: WalletSendCalls) => getWalletCallsErrorReply(request.method, {
	code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
	message: 'wallet_sendCalls batches are simulated before approval, which requires an Interceptor RPC connection for this network.',
})

export const getSimulatedShowCallsStatusReply = (request: WalletShowCallsStatus) => getWalletCallsErrorReply(request.method, {
	code: METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER,
	message: 'wallet_showCallsStatus is not supported in simulation mode. Simulated batches are shown in the Interceptor simulation stack.',
})
